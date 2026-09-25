import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../client";
import { rowsOf } from "../helpers";
import { withSerializableTxn } from "../txn";
import { networkingAudit, networkingDeliveries } from "../schema/networking";
import type { NetworkingDeliveryRow } from "./networking-delivery";
import { networkingMeetingStatusSql } from "./networking-meetings";

/** Aggregate-only durable report data contains no participant names, messages or contact details. */
export async function networkingPostEventReportData(
  eventId: string,
  timezone = "UTC",
) {
  const db = getDb();
  const [summary] = rowsOf<Record<string, number>>(
    await db.execute(sql`
    SELECT
      (SELECT count(*)::int4 FROM networking_profiles WHERE event_id=${eventId}) AS participants,
      (SELECT count(*)::int4 FROM networking_profiles WHERE event_id=${eventId} AND last_active_at IS NOT NULL) AS active_participants,
      (SELECT count(*)::int4 FROM networking_audit WHERE event_id=${eventId} AND action='PROFILE_VIEW') AS profile_views,
      (SELECT count(*)::int4 FROM networking_interests WHERE event_id=${eventId} AND action='LIKE') AS interests,
      (SELECT count(*)::int4 FROM networking_connections WHERE event_id=${eventId}) AS connections,
      (SELECT count(*)::int4 FROM networking_messages WHERE event_id=${eventId}) AS messages,
      (SELECT count(*)::int4 FROM networking_meetings WHERE event_id=${eventId}) AS meeting_requests,
      (SELECT count(*)::int4 FROM networking_meetings WHERE event_id=${eventId} AND status IN (${networkingMeetingStatusSql("booked")})) AS meetings,
      (SELECT count(*)::int4 FROM networking_meetings WHERE event_id=${eventId} AND status IN (${networkingMeetingStatusSql("awaiting")})) AS pending_meetings,
      (SELECT count(*)::int4 FROM (SELECT connection_id FROM networking_messages WHERE event_id=${eventId} GROUP BY connection_id HAVING count(DISTINCT sender_id)=2) replies) AS responsive_conversations,
      (SELECT count(DISTINCT connection_id)::int4 FROM networking_messages WHERE event_id=${eventId}) AS conversations,
      (SELECT count(*)::int4 FROM networking_meetings WHERE event_id=${eventId} AND status='COMPLETED') AS completed_meetings,
      (SELECT count(*)::int4 FROM networking_meetings WHERE event_id=${eventId} AND status='NO_SHOW') AS no_shows,
      (SELECT count(*)::int4 FROM networking_meetings WHERE event_id=${eventId} AND status='CANCELLED') AS cancelled_meetings,
      (SELECT count(*)::int4 FROM email_logs WHERE context_snapshot->>'dispatchOwner'='networking' AND context_snapshot->>'eventId'=${eventId} AND sent_at IS NOT NULL) AS emails_sent,
      (SELECT count(*)::int4 FROM email_logs WHERE context_snapshot->>'dispatchOwner'='networking' AND context_snapshot->>'eventId'=${eventId} AND opened_at IS NOT NULL) AS emails_opened,
      (SELECT count(*)::int4 FROM email_logs WHERE context_snapshot->>'dispatchOwner'='networking' AND context_snapshot->>'eventId'=${eventId} AND clicked_at IS NOT NULL) AS emails_clicked
  `),
  );
  const sectors = rowsOf<{
    sector: string;
    participants: number;
    connections: number;
    meetings: number;
  }>(
    await db.execute(sql`
    SELECT p.sector,count(DISTINCT p.id)::int4 AS participants,count(DISTINCT c.id)::int4 AS connections,count(DISTINCT m.id)::int4 AS meetings
    FROM networking_profiles p LEFT JOIN networking_connections c ON c.event_id=p.event_id AND (c.profile_a_id=p.id OR c.profile_b_id=p.id)
      LEFT JOIN networking_meetings m ON m.event_id=p.event_id AND (m.requester_id=p.id OR m.recipient_id=p.id) AND m.status IN (${networkingMeetingStatusSql("booked")})
    WHERE p.event_id=${eventId} GROUP BY p.sector ORDER BY participants DESC,p.sector
  `),
  );
  const timeSeries = rowsOf<{
    date: string;
    connections: number;
    messages: number;
    meetings: number;
  }>(
    await db.execute(sql`
    SELECT to_char(stamp AT TIME ZONE ${timezone},'YYYY-MM-DD') AS date,
      sum(connections)::int4 AS connections,sum(messages)::int4 AS messages,sum(meetings)::int4 AS meetings
    FROM (
      SELECT created_at AS stamp,1 AS connections,0 AS messages,0 AS meetings FROM networking_connections WHERE event_id=${eventId}
      UNION ALL SELECT created_at,0,1,0 FROM networking_messages WHERE event_id=${eventId}
      UNION ALL SELECT starts_at,0,0,1 FROM networking_meetings WHERE event_id=${eventId} AND status IN (${networkingMeetingStatusSql("booked")})
    ) activity GROUP BY 1 ORDER BY 1
  `),
  );
  return { summary: summary ?? {}, sectors, timeSeries };
}
export async function saveNetworkingPostEventReport(
  row: NetworkingDeliveryRow,
  storageKey: string,
  summary: Record<string, number>,
) {
  // SERIALIZABLE with retries: the lease-checked claim and its audit row commit together or not at all.
  return withSerializableTxn(async (tx) => {
    const data = { storageKey, generatedAt: new Date().toISOString(), summary };
    const claimed = await tx
      .update(networkingDeliveries)
      .set({
        status: "SENT",
        lockedUntil: null,
        payload: data,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(networkingDeliveries.id, row.id),
          eq(networkingDeliveries.status, "PROCESSING"),
          eq(networkingDeliveries.lockedUntil, row.lockedUntil!),
          sql`${networkingDeliveries.lockedUntil}>now()`,
        ),
      )
      .returning({ id: networkingDeliveries.id });
    if (!claimed.length) return false;
    await tx
      .insert(networkingAudit)
      .values({
        id: row.id,
        eventId: row.eventId,
        actorId: "networking-worker",
        action: "POST_EVENT_REPORT",
        targetId: row.eventId,
        data,
      })
      .onConflictDoNothing({ target: networkingAudit.id });
    return true;
  });
}
export async function latestNetworkingPostEventReport(eventId: string) {
  const [row] = await getDb()
    .select()
    .from(networkingAudit)
    .where(
      and(
        eq(networkingAudit.eventId, eventId),
        eq(networkingAudit.action, "POST_EVENT_REPORT"),
      ),
    )
    .orderBy(desc(networkingAudit.createdAt))
    .limit(1);
  if (!row || typeof row.data.storageKey !== "string") return null;
  return {
    storageKey: row.data.storageKey,
    generatedAt: String(row.data.generatedAt),
    summary: row.data.summary as Record<string, number>,
  };
}
