import { NETWORKING_DELIVERY_MAX_ATTEMPTS } from "./networking-delivery";
import { NETWORKING_SCHEDULED_NOTIFICATION_COPY } from "@app/contracts";
import { activeNetworkingParticipant, unblockedNetworkingPair } from "./networking-eligibility";
import { eq, sql } from "drizzle-orm";
import { getDb, type DbExecutor } from "../client";
import { rowsOf } from "../helpers";
import { withSerializableTxn } from "../txn";
import { networkingAllocationLocks, networkingProfiles } from "../schema/networking";

// Closed internal column set keeps the existing raw SQL spelling (including e.id).
function eventScope(eventId?: string, column: "event_id" | "m.event_id" | "p.event_id" | "e.id" | "d.event_id" | "c.event_id" = "event_id") {
  return eventId ? sql`AND ${sql.raw(column)}=${eventId}` : sql``;
}
const REMINDERS = [
  { type: "MEETING_REMINDER_DAY", hours: 24, minHours: 23, titles: { fr: NETWORKING_SCHEDULED_NOTIFICATION_COPY.fr.MEETING_REMINDER_DAY, ar: NETWORKING_SCHEDULED_NOTIFICATION_COPY.ar.MEETING_REMINDER_DAY, en: NETWORKING_SCHEDULED_NOTIFICATION_COPY.en.MEETING_REMINDER_DAY } },
  { type: "MEETING_REMINDER_HOUR", hours: 1, minHours: 0, titles: { fr: NETWORKING_SCHEDULED_NOTIFICATION_COPY.fr.MEETING_REMINDER_HOUR, ar: NETWORKING_SCHEDULED_NOTIFICATION_COPY.ar.MEETING_REMINDER_HOUR, en: NETWORKING_SCHEDULED_NOTIFICATION_COPY.en.MEETING_REMINDER_HOUR } },
] as const;

// Raw released-status literals match NETWORKING_RELEASED_MEETING_STATUSES; retain their original ordering.
/** Expire proposals without loading an event's meeting history on every agenda read. */
export async function expireNetworkingProposals(eventId?: string, db: DbExecutor = getDb()) {
  const scope = eventScope(eventId);
  await db.execute(
    sql`UPDATE networking_meetings SET status='EXPIRED',revision=revision+1,updated_at=now() WHERE status='PENDING' AND expires_at<=now() ${scope}`,
  );
  await db.execute(
    sql`UPDATE networking_meetings SET proposed_starts_at=NULL,proposal_by=NULL,revision=revision+1,updated_at=now() WHERE proposed_starts_at IS NOT NULL AND expires_at<=now() ${scope}`,
  );
  await db.execute(sql`DELETE FROM networking_reservations WHERE meeting_id IN (
    SELECT id FROM networking_meetings WHERE status IN ('EXPIRED','DECLINED','CANCELLED') ${scope}
  ) ${scope}`);
}

/** Each reminder and its in-app record are committed by one statement, with delivery dedupe winning races. */
export async function maintainNetworkingLifecycle(
  eventId?: string,
  onAfterPurge?: (profiles: { id: string; eventId: string; photoUrl: string | null }[]) => Promise<void>,
) {
  const db = getDb();
  const scope = eventScope(eventId);
  await expireNetworkingProposals(eventId, db);
  for (const { type, hours, minHours, titles } of REMINDERS) {
    await db.execute(sql`
      WITH candidates AS (
        SELECT gen_random_uuid()::text AS notification_id,m.id AS meeting_id,m.event_id,m.revision,p.id AS profile_id,
          '/e/'||e.slug||'/agenda' AS href,
          CASE p.language WHEN 'fr' THEN ${titles.fr}::text WHEN 'ar' THEN ${titles.ar}::text ELSE ${titles.en}::text END AS title,
          to_char(m.starts_at AT TIME ZONE COALESCE(c.config->>'timezone','UTC'),'YYYY-MM-DD HH24:MI')||' · '||COALESCE(c.config->>'timezone','UTC') AS body
        FROM networking_meetings m JOIN networking_profiles p ON p.id=m.requester_id OR p.id=m.recipient_id
        JOIN networking_configs c ON c.event_id=m.event_id JOIN events e ON e.id=m.event_id
        JOIN clients cl ON cl.id=e.client_id JOIN registrations r ON r.id=p.registration_id
        JOIN networking_profiles peer ON peer.id=CASE WHEN p.id=m.requester_id THEN m.recipient_id ELSE m.requester_id END AND peer.event_id=m.event_id
        JOIN registrations peer_registration ON peer_registration.id=peer.registration_id
        WHERE m.status='CONFIRMED' AND m.starts_at>now()+interval '1 hour'*${minHours}::int AND m.starts_at<=now()+interval '1 hour'*${hours}::int
          AND m.created_at<m.starts_at-interval '1 hour'*${hours}::int
          AND c.config->>'enabled'='true' AND cl.active AND cl.enabled_modules @> ARRAY['networking','registrations','emails']::text[]
          AND ${activeNetworkingParticipant("p", "r")}
          AND c.config->'eligiblePaymentStatuses' ? r.payment_status::text
          AND ${activeNetworkingParticipant("peer", "peer_registration")}
          AND c.config->'eligiblePaymentStatuses' ? peer_registration.payment_status::text
          AND ${unblockedNetworkingPair(sql.raw("m.event_id"), sql.raw("m.requester_id"), sql.raw("m.recipient_id"))}
          ${eventScope(eventId, "m.event_id")}
      ), inserted AS (
        INSERT INTO networking_deliveries (id,event_id,profile_id,type,payload,status,available_at,dedupe_key,created_at,updated_at)
        SELECT gen_random_uuid()::text,event_id,profile_id,${type},jsonb_build_object('notificationId',notification_id,'meetingId',meeting_id,'revision',revision,'title',title,'body',body,'href',href),
          'PENDING',now(),${type}||':'||meeting_id||':'||revision::text||':'||profile_id,now(),now() FROM candidates
        ON CONFLICT (dedupe_key) DO NOTHING RETURNING *
      )
      INSERT INTO networking_notifications (id,event_id,profile_id,type,title,body,href,data,created_at)
      SELECT payload->>'notificationId',event_id,profile_id,type,payload->>'title',payload->>'body',payload->>'href',payload-'title'-'body'-'href',now() FROM inserted
    `);
  }
  // Deliver the previous event-local day's unread updates after 08:00, once per event-local date.
  await db.execute(sql`
    INSERT INTO networking_deliveries (id,event_id,profile_id,type,payload,status,available_at,dedupe_key,created_at,updated_at)
    SELECT gen_random_uuid()::text,p.event_id,p.id,'DAILY_DIGEST',jsonb_build_object('notificationIds',jsonb_agg(n.id ORDER BY n.created_at)),
      'PENDING',now(),'digest:'||p.id||':'||(now() AT TIME ZONE COALESCE(c.config->>'timezone','UTC'))::date::text,now(),now()
    FROM networking_profiles p JOIN networking_configs c ON c.event_id=p.event_id
      JOIN networking_notifications n ON n.profile_id=p.id AND n.event_id=p.event_id AND (n.read_at IS NULL OR n.type='POST_EVENT_CONTACTS')
      JOIN registrations r ON r.id=p.registration_id
    WHERE p.email_preference='DAILY' AND p.status='ACTIVE' AND p.consent AND p.withdrawn_at IS NULL
      AND r.networking_opt_in IS DISTINCT FROM false AND c.config->>'enabled'='true'
      AND c.config->'eligiblePaymentStatuses' ? r.payment_status::text
      AND (now() AT TIME ZONE COALESCE(c.config->>'timezone','UTC'))::time>=time '08:00'
      AND (n.created_at AT TIME ZONE COALESCE(c.config->>'timezone','UTC'))::date=(now() AT TIME ZONE COALESCE(c.config->>'timezone','UTC'))::date-1
      ${eventScope(eventId, "p.event_id")}
    GROUP BY p.id,p.event_id,c.config ON CONFLICT (dedupe_key) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO networking_deliveries (id,event_id,type,payload,status,available_at,dedupe_key,created_at,updated_at)
    SELECT gen_random_uuid()::text,e.id,'POST_EVENT_REPORT','{}'::jsonb,'PENDING',now(),'post-event-report:'||e.id,now(),now()
    FROM events e JOIN networking_configs c ON c.event_id=e.id WHERE c.config->>'enabled'='true' AND e.end_date+interval '24 hours'<=now()
      ${eventScope(eventId, "e.id")} ON CONFLICT (dedupe_key) DO NOTHING
  `);
  await db.execute(sql`
    WITH candidates AS (
      SELECT gen_random_uuid()::text AS notification_id,p.id AS profile_id,p.event_id,'/e/'||e.slug||'/connections' AS href,
        CASE p.language WHEN 'fr' THEN ${NETWORKING_SCHEDULED_NOTIFICATION_COPY.fr.POST_EVENT_CONTACTS}::text WHEN 'ar' THEN ${NETWORKING_SCHEDULED_NOTIFICATION_COPY.ar.POST_EVENT_CONTACTS}::text ELSE ${NETWORKING_SCHEDULED_NOTIFICATION_COPY.en.POST_EVENT_CONTACTS}::text END AS title,
        CASE p.language WHEN 'fr' THEN ${NETWORKING_SCHEDULED_NOTIFICATION_COPY.fr.postEventContactsBody}::text WHEN 'ar' THEN ${NETWORKING_SCHEDULED_NOTIFICATION_COPY.ar.postEventContactsBody}::text ELSE ${NETWORKING_SCHEDULED_NOTIFICATION_COPY.en.postEventContactsBody}::text END AS body
      FROM networking_profiles p JOIN events e ON e.id=p.event_id JOIN networking_configs c ON c.event_id=p.event_id JOIN registrations r ON r.id=p.registration_id
      WHERE e.end_date+interval '24 hours'<=now() AND c.config->>'enabled'='true' AND p.status='ACTIVE' AND p.consent AND p.withdrawn_at IS NULL
        AND r.networking_opt_in IS DISTINCT FROM false AND c.config->'eligiblePaymentStatuses' ? r.payment_status::text
        ${eventScope(eventId, "p.event_id")}
    ), inserted AS (
      INSERT INTO networking_deliveries (id,event_id,profile_id,type,payload,status,available_at,dedupe_key,created_at,updated_at)
      SELECT gen_random_uuid()::text,event_id,profile_id,'POST_EVENT_CONTACTS',jsonb_build_object('notificationId',notification_id,'href',href),
        'PENDING',now(),'post-event-contacts:'||event_id||':'||profile_id,now(),now() FROM candidates
      ON CONFLICT (dedupe_key) DO NOTHING RETURNING *
    )
    INSERT INTO networking_notifications (id,event_id,profile_id,type,title,body,href,data,created_at)
    SELECT i.payload->>'notificationId',i.event_id,i.profile_id,i.type,c.title,c.body,c.href,jsonb_build_object('postEventContacts',true),now()
    FROM inserted i JOIN candidates c ON c.notification_id=i.payload->>'notificationId'
  `);
  // Expired/exhausted codes are scrubbed even if a provider never became available.
  await db.execute(sql`UPDATE networking_deliveries d SET payload=jsonb_build_object('challengeId',d.payload->>'challengeId','outcome','expired'),status='SKIPPED',locked_until=NULL,last_error=NULL,updated_at=now()
    WHERE d.type='OTP' AND d.status<>'SENT' AND (d.status<>'PROCESSING' OR d.locked_until<now())
      AND (d.attempts>=${sql.raw(String(NETWORKING_DELIVERY_MAX_ATTEMPTS))} OR NOT EXISTS (SELECT 1 FROM networking_challenges c WHERE c.id=d.payload->>'challengeId' AND c.event_id=d.event_id AND c.expires_at>now() AND c.consumed_at IS NULL AND c.attempts<5))
      ${eventScope(eventId, "d.event_id")}`);
  await db.execute(
    sql`UPDATE networking_deliveries SET status='FAILED',locked_until=NULL,last_error='Delivery retry limit exhausted',updated_at=now() WHERE status='PROCESSING' AND locked_until<now() AND attempts>=${sql.raw(String(NETWORKING_DELIVERY_MAX_ATTEMPTS))} ${scope}`,
  );
  await db.execute(
    sql`DELETE FROM networking_challenges WHERE expires_at<now()-interval '1 day' ${scope}`,
  );
  await db.execute(
    sql`DELETE FROM networking_sessions WHERE (expires_at<now()-interval '1 day' OR revoked_at<now()-interval '1 day') ${scope}`,
  );
  const expired = rowsOf<{ event_id: string }>(
    await db.execute(
      sql`SELECT c.event_id FROM networking_configs c JOIN events e ON e.id=c.event_id WHERE EXISTS (SELECT 1 FROM networking_profiles p WHERE p.event_id=c.event_id) AND e.end_date+COALESCE((c.config->>'retentionDays')::int,90)*interval '1 day'<now() ${eventScope(eventId, "c.event_id")}`,
    ),
  );
  for (const { event_id } of expired) {
    // SERIALIZABLE with retries, like every networking write: a concurrent
    // participant write either commits first or retries after the purge.
    const profiles = await withSerializableTxn(async (tx) => {
      await tx.execute(
        sql`UPDATE networking_configs SET config=jsonb_set(config,'{enabled}','false'::jsonb),updated_at=now() WHERE event_id=${event_id}`,
      );
      // photoUrl is the profile's only managed asset; preserve it before cascading deletion.
      const profiles = await tx
        .select({ id: networkingProfiles.id, eventId: networkingProfiles.eventId, photoUrl: networkingProfiles.photoUrl })
        .from(networkingProfiles)
        .where(eq(networkingProfiles.eventId, event_id));
      await tx
        .delete(networkingProfiles)
        .where(eq(networkingProfiles.eventId, event_id));
      await tx
        .delete(networkingAllocationLocks)
        .where(eq(networkingAllocationLocks.eventId, event_id));
      return profiles;
    });
    // Best effort after commit: no durable retries; a crash or cleanup failure can orphan photos.
    await onAfterPurge?.(profiles);
  }
}
