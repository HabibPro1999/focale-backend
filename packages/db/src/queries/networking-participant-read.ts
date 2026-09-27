import { activeNetworkingParticipant, notNetworkingSelfEmail, unblockedNetworkingPair } from "./networking-eligibility";
import type { NetworkingConfig } from "@app/contracts";
import { and, count, desc, eq, getTableColumns, inArray, lt, or, sql } from "drizzle-orm";
import { getDb, type DbExecutor } from "../client";
import { rowsOf } from "../helpers";
import { networkingAudit as audit, networkingConnections as connections, networkingMeetings as meetings, networkingMessages as messages, networkingNotifications as notifications, networkingProfiles as profiles } from "../schema/networking";
import { registrations } from "../schema/registrations";
import { clampNetworkingPageLimit } from "./networking-pagination";

export interface NetworkingParticipantPage {
  limit: number;
  after?: { at: Date; id: string };
}

function connectionVisibility(eventId: string, profileId: string, paymentStatuses: Readonly<NetworkingConfig["eligiblePaymentStatuses"]>) {
  return and(
        eq(connections.eventId, eventId),
        eq(profiles.eventId, eventId),
        eq(registrations.eventId, eventId),
        or(
          eq(connections.profileAId, profileId),
          eq(connections.profileBId, profileId),
        ),
        eq(profiles.status, "ACTIVE"),
        eq(profiles.consent, true),
        sql`${profiles.withdrawnAt} IS NULL`,
        sql`${registrations.networkingOptIn} IS DISTINCT FROM false`,
        inArray(registrations.paymentStatus, [...paymentStatuses]),
        notNetworkingSelfEmail(profiles.email, profileId, eventId),
        sql`NOT EXISTS (SELECT 1 FROM networking_blocks b WHERE b.event_id=${eventId} AND
        ((b.profile_id=${profileId} AND b.target_id=${profiles.id}) OR (b.target_id=${profileId} AND b.profile_id=${profiles.id})))`,
      );
}

export async function countNetworkingConnectionSummaries(eventId: string, profileId: string, paymentStatuses: Readonly<NetworkingConfig["eligiblePaymentStatuses"]>) {
  const [row] = await getDb().select({ total: sql<number>`count(*)::int`.mapWith(Number) })
    .from(connections)
    .innerJoin(profiles, eq(profiles.id, sql`CASE WHEN ${connections.profileAId}=${profileId} THEN ${connections.profileBId} ELSE ${connections.profileAId} END`))
    .innerJoin(registrations, eq(registrations.id, profiles.registrationId))
    .where(connectionVisibility(eventId, profileId, paymentStatuses));
  return row?.total ?? 0;
}

function participantMeetingsScope(eventId: string, profileId: string) {
  return and(eq(meetings.eventId, eventId), or(eq(meetings.requesterId, profileId), eq(meetings.recipientId, profileId)));
}

export async function countNetworkingParticipantMeetings(eventId: string, profileId: string) {
  const [row] = await getDb().select({ total: sql<number>`count(*)::int`.mapWith(Number) })
    .from(meetings).where(participantMeetingsScope(eventId, profileId));
  return row?.total ?? 0;
}

/** One scoped query for connection previews; never load the event's message history. */
export async function listNetworkingConnectionSummaries(
  eventId: string,
  profileId: string,
  paymentStatuses: Readonly<NetworkingConfig["eligiblePaymentStatuses"]>,
  page?: NetworkingParticipantPage,
  filter: { connectionId?: string } = {},
) {
  const db = getDb();
  const counterpart = sql`CASE WHEN ${connections.profileAId}=${profileId} THEN ${connections.profileBId} ELSE ${connections.profileAId} END`;
  const scoped = and(
    connectionVisibility(eventId, profileId, paymentStatuses),
    filter.connectionId ? eq(connections.id, filter.connectionId) : undefined,
  );
  // Keyset + limit pick the page first, so the latest-message lateral runs for at most limit+1 rows.
  const pageIds = page
    ? db
        .select({ id: connections.id })
        .from(connections)
        .innerJoin(profiles, eq(profiles.id, counterpart))
        .innerJoin(registrations, eq(registrations.id, profiles.registrationId))
        .where(and(scoped, page.after
          ? sql`(${connections.createdAt}, ${connections.id}) < (${page.after.at.toISOString()}, ${page.after.id})`
          : undefined))
        .orderBy(desc(connections.createdAt), desc(connections.id))
        .limit(page.limit + 1)
    : undefined;
  const latest = db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.eventId, eventId),
        eq(messages.connectionId, connections.id),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1)
    .as("latest_message");
  const readAt = sql`CASE WHEN ${connections.profileAId}=${profileId} THEN ${connections.readAAt} ELSE ${connections.readBAt} END`;
  return db
    .select({
      id: connections.id,
      profile: getTableColumns(profiles),
      createdAt: connections.createdAt,
      lastMessage: {
        id: latest.id,
        connectionId: latest.connectionId,
        senderId: latest.senderId,
        body: latest.body,
        createdAt: latest.createdAt,
      },
      unreadCount:
        sql<number>`(SELECT count(*)::int FROM networking_messages m WHERE m.event_id=${eventId}
      AND m.connection_id=${connections.id} AND m.sender_id<>${profileId} AND (${readAt} IS NULL OR m.created_at>${readAt}))`.mapWith(
          Number,
        ),
    })
    .from(connections)
    .innerJoin(profiles, eq(profiles.id, counterpart))
    .innerJoin(registrations, eq(registrations.id, profiles.registrationId))
    .leftJoinLateral(latest, sql`true`)
    .where(pageIds ? and(eq(connections.eventId, eventId), inArray(connections.id, pageIds)) : scoped)
    .orderBy(...(page
      ? [desc(connections.createdAt), desc(connections.id)]
      : [sql`coalesce(${latest.createdAt},${connections.createdAt}) DESC`, connections.id]));
}

export async function listNetworkingParticipantMeetings(
  eventId: string,
  profileId: string,
  page?: NetworkingParticipantPage,
) {
  const query = getDb()
    .select()
    .from(meetings)
    .where(and(participantMeetingsScope(eventId, profileId), page?.after
      ? sql`(${meetings.startsAt}, ${meetings.id}) > (${page.after.at.toISOString()}, ${page.after.id})`
      : undefined))
    .orderBy(meetings.startsAt, meetings.id)
    .$dynamic();
  return page ? query.limit(page.limit + 1) : query;
}

export async function markNetworkingMessageNotificationsRead(
  eventId: string,
  profileId: string,
  connectionId: string,
  readAt: Date,
  db: DbExecutor = getDb(),
) {
  await db
    .update(notifications)
    .set({ readAt })
    .where(
      and(
        eq(notifications.eventId, eventId),
        eq(notifications.profileId, profileId),
        eq(notifications.type, "MESSAGE"),
        sql`${notifications.readAt} IS NULL`,
        sql`${notifications.data}->>'connectionId'=${connectionId}`,
        sql`${notifications.createdAt}<=${readAt}`,
      ),
    );
}

export async function networkingUnreadMessageCount(
  eventId: string,
  profileId: string,
  db: DbExecutor = getDb(),
) {
  const [row] = rowsOf<{ count: number }>(
    await db.execute(sql`
    SELECT count(*)::int AS count FROM networking_connections c
    JOIN networking_messages m ON m.connection_id=c.id AND m.event_id=c.event_id
    JOIN networking_profiles p ON p.id=CASE WHEN c.profile_a_id=${profileId} THEN c.profile_b_id ELSE c.profile_a_id END AND p.event_id=c.event_id
    JOIN registrations r ON r.id=p.registration_id AND r.event_id=c.event_id
    JOIN networking_configs cfg ON cfg.event_id=c.event_id
    WHERE c.event_id=${eventId} AND (c.profile_a_id=${profileId} OR c.profile_b_id=${profileId})
      AND m.sender_id<>${profileId} AND (CASE WHEN c.profile_a_id=${profileId} THEN c.read_a_at ELSE c.read_b_at END IS NULL
        OR m.created_at>CASE WHEN c.profile_a_id=${profileId} THEN c.read_a_at ELSE c.read_b_at END)
      AND ${activeNetworkingParticipant("p", "r")}
      AND lower(p.email)<>(SELECT lower(email) FROM networking_profiles WHERE id=${profileId} AND event_id=${eventId})
      AND cfg.config->'eligiblePaymentStatuses' ? r.payment_status::text
      AND NOT EXISTS (SELECT 1 FROM networking_blocks b WHERE b.event_id=c.event_id
        AND ((b.profile_id=${profileId} AND b.target_id=p.id) OR (b.profile_id=p.id AND b.target_id=${profileId})))
  `),
  );
  return Number(row?.count ?? 0);
}

export async function recordNetworkingProfileView(
  eventId: string,
  actorId: string,
  targetId: string,
  viewId?: string,
) {
  await getDb()
    .insert(audit)
    .values({ id: viewId, eventId, actorId, targetId, action: "PROFILE_VIEW" })
    .onConflictDoNothing({ target: audit.id });
}

export async function networkingNotificationsSince(
  eventId: string,
  profileId: string,
  since: Date,
) {
  return getDb()
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.eventId, eventId),
        eq(notifications.profileId, profileId),
        sql`${notifications.createdAt}>=${since}`,
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(100);
}

export async function listNetworkingMessages(
  eventId: string,
  connectionId: string,
  query: { before?: string; beforeId?: string; limit?: number } = {},
  db: DbExecutor = getDb(),
) {
  const where = and(
    eq(messages.eventId, eventId),
    eq(messages.connectionId, connectionId),
    query.before
      ? query.beforeId
        ? or(
            lt(messages.createdAt, new Date(query.before)),
            and(
              eq(messages.createdAt, new Date(query.before)),
              lt(messages.id, query.beforeId),
            ),
          )
        : lt(messages.createdAt, new Date(query.before))
      : undefined,
  );
  const [items, counts] = await Promise.all([
    db
      .select()
      .from(messages)
      .where(where)
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(clampNetworkingPageLimit(query.limit ?? 50)),
    db.select({ total: count() }).from(messages).where(where),
  ]);
  const oldest = items.at(-1);
  const total = counts[0]?.total ?? 0;
  return {
    items: items.reverse(),
    total,
    nextCursor:
      oldest && total > items.length
        ? { before: oldest.createdAt.toISOString(), beforeId: oldest.id }
        : null,
  };
}

export async function listNetworkingNotifications(
  eventId: string,
  profileId: string,
  page = 1,
  limit = 30,
  db: DbExecutor = getDb(),
) {
  const where = and(
    eq(notifications.eventId, eventId),
    eq(notifications.profileId, profileId),
  );
  const [items, counts, unreadMessageCount] = await Promise.all([
    db
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(clampNetworkingPageLimit(limit))
      // Preserve the legacy offset based on the unclamped requested limit.
      .offset((Math.max(1, page) - 1) * limit),
    db
      .select({
        total: count(),
        unreadCount: sql<number>`count(*) FILTER (WHERE ${notifications.readAt} IS NULL)::integer`,
      })
      .from(notifications)
      .where(where),
    networkingUnreadMessageCount(eventId, profileId, db),
  ]);
  return {
    items,
    total: counts[0]?.total ?? 0,
    unreadCount: counts[0]?.unreadCount ?? 0,
    unreadMessageCount,
  };
}

export interface NetworkingExportContact { firstName: string; lastName: string; company: string; jobTitle: string; sector: string; city: string; country: string; website: string | null; }

/** Private registration email/phone are never part of a participant connection export. */
export async function networkingParticipantExportContacts(eventId: string, profileId: string): Promise<NetworkingExportContact[]> {
  return rowsOf<NetworkingExportContact>(await getDb().execute(sql`
    SELECT p.first_name AS "firstName",p.last_name AS "lastName",p.company,p.job_title AS "jobTitle",p.sector,p.city,p.country,p.website
    FROM networking_connections c JOIN networking_profiles p ON p.id=CASE WHEN c.profile_a_id=${profileId} THEN c.profile_b_id ELSE c.profile_a_id END
      JOIN registrations r ON r.id=p.registration_id JOIN networking_configs cfg ON cfg.event_id=c.event_id
    WHERE c.event_id=${eventId} AND p.event_id=${eventId} AND (c.profile_a_id=${profileId} OR c.profile_b_id=${profileId})
      AND ${activeNetworkingParticipant("p", "r")}
      AND cfg.config->'eligiblePaymentStatuses' ? r.payment_status::text
      AND ${unblockedNetworkingPair(sql.raw("c.event_id"), profileId, sql.raw("p.id"))}
    ORDER BY p.last_name,p.first_name,p.id
  `));
}
