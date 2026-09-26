import { and, asc, desc, eq, getTableColumns, gt, gte, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb, type DbExecutor } from "../client";
import { rowsOf } from "../helpers";
import {
  networkingConnections as connections,
  networkingProfiles as profiles,
  networkingMessages as messages,
  networkingMeetings as meetings,
  networkingAudit as audit,
  networkingNotifications as notifications,
  networkingConfigs,
  networkingInterests as interests,
} from "../schema/networking";
import { registrations } from "../schema/registrations";
import { peerCounterpart, profileCounterpart, type NetworkingPaymentStatuses } from "../policy/networking-eligibility";

export interface NetworkingParticipantPage {
  limit: number;
  after?: { at: Date; id: string };
}

/** The participant's connections whose counterpart they may still see (4.6: counterpart `peer` mode). */
function connectionVisibility(eventId: string, profileId: string, paymentStatuses: readonly string[]) {
  return and(
    eq(connections.eventId, eventId),
    eq(profiles.eventId, eventId),
    or(
      eq(connections.profileAId, profileId),
      eq(connections.profileBId, profileId),
    ),
    peerCounterpart(profiles, registrations, paymentStatuses, { eventId, profileId }),
  );
}

export async function countNetworkingConnectionSummaries(eventId: string, profileId: string, paymentStatuses: readonly string[]) {
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
  paymentStatuses: readonly string[],
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

type IncomingScope = { eventId: string; profileId: string; statuses: NetworkingPaymentStatuses; discoveryEnabled: boolean };

/**
 * A batch of candidate likes for the incoming list, newest first after the
 * keyset position, each with its sender and whether the participant may see
 * the sender in `profile` mode (4.6). The candidates are a LIMITed subquery
 * on the likes alone, planned on its own: it reads
 * networking_interests_incoming_idx (0034) backwards and stops after
 * `batch` rows, whatever the planner estimates for the sender filters.
 */
export function networkingIncomingCandidatesQuery(
  input: IncomingScope,
  after: { at: Date; id: string } | undefined,
  batch: number,
  db: DbExecutor = getDb(),
) {
  const candidates = db
    .select({ id: interests.id, profileId: interests.profileId, createdAt: interests.createdAt })
    .from(interests)
    .where(and(
      eq(interests.eventId, input.eventId),
      eq(interests.targetId, input.profileId),
      // The index predicate as a literal, so the planner can match it.
      sql`${interests.action}='LIKE'`,
      // created_at is a naive UTC timestamp (the shared `timestamps` columns).
      after
        ? sql`(${interests.createdAt}, ${interests.id}) < (CAST(${after.at.toISOString()} AS timestamptz) AT TIME ZONE 'UTC', ${after.id})`
        : undefined,
    ))
    .orderBy(desc(interests.createdAt), desc(interests.id))
    .limit(batch)
    .as("incoming_candidates");
  const visible = profileCounterpart(profiles, registrations, input.statuses, { eventId: input.eventId, profileId: input.profileId }, input.discoveryEnabled);
  return db
    .select({
      id: candidates.id,
      createdAt: candidates.createdAt,
      profile: getTableColumns(profiles),
      visible: sql<boolean>`EXISTS (SELECT 1 FROM ${registrations} WHERE ${registrations.id}=${profiles.registrationId} AND ${visible})`.mapWith(Boolean),
    })
    .from(candidates)
    .innerJoin(profiles, and(eq(profiles.id, candidates.profileId), eq(profiles.eventId, input.eventId)))
    .orderBy(desc(candidates.createdAt), desc(candidates.id));
}

/**
 * Who liked the participant (an exhibitor's incoming interests), newest first
 * by keyset on (created_at, id): up to `limit + 1` likes whose sender the
 * participant may see (the extra one says whether more follow). One statement
 * per page unless senders are filtered out, then one more per further batch.
 */
export async function listNetworkingIncomingInterests(input: IncomingScope, page: NetworkingParticipantPage) {
  const want = page.limit + 1;
  const items: { id: string; createdAt: Date; profile: typeof profiles.$inferSelect }[] = [];
  let after = page.after;
  for (;;) {
    const batch = await networkingIncomingCandidatesQuery(input, after, want);
    for (const row of batch) {
      if (!row.visible) continue;
      items.push({ id: row.id, createdAt: row.createdAt, profile: row.profile });
      if (items.length === want) return items;
    }
    const last = batch.at(-1);
    if (batch.length < want || !last) return items;
    after = { at: last.createdAt, id: last.id };
  }
}

function incomingScope(input: IncomingScope) {
  return and(
    eq(interests.eventId, input.eventId),
    eq(interests.targetId, input.profileId),
    sql`${interests.action}='LIKE'`,
    eq(profiles.eventId, input.eventId),
    profileCounterpart(profiles, registrations, input.statuses, { eventId: input.eventId, profileId: input.profileId }, input.discoveryEnabled),
  );
}

/** Every like whose sender the participant may see (the first page's total). */
export async function countNetworkingIncomingInterests(input: IncomingScope) {
  const [row] = await getDb().select({ total: sql<number>`count(*)::int`.mapWith(Number) })
    .from(interests)
    .innerJoin(profiles, eq(profiles.id, interests.profileId))
    .innerJoin(registrations, eq(registrations.id, profiles.registrationId))
    .where(incomingScope(input));
  return row?.total ?? 0;
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

const unreadPeer = alias(profiles, "p");
const unreadRegistration = alias(registrations, "r");
const unreadConfig = alias(networkingConfigs, "cfg");
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
    JOIN registrations r ON r.id=p.registration_id
    JOIN networking_configs cfg ON cfg.event_id=c.event_id
    WHERE c.event_id=${eventId} AND (c.profile_a_id=${profileId} OR c.profile_b_id=${profileId})
      AND m.sender_id<>${profileId} AND (CASE WHEN c.profile_a_id=${profileId} THEN c.read_a_at ELSE c.read_b_at END IS NULL
        OR m.created_at>CASE WHEN c.profile_a_id=${profileId} THEN c.read_a_at ELSE c.read_b_at END)
      AND ${peerCounterpart(unreadPeer, unreadRegistration, { config: unreadConfig.config }, { eventId, profileId })}
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

/**
 * One keyset page of the participant stream's catch-up: this participant's
 * notifications created at or after `since`, in id order (UUIDv7, so about
 * creation order), after `afterId`. Paging by the unique id is exact even when
 * many rows share a timestamp (one transaction writes them all with the same
 * `now()`); the `(profile_id, created_at)` index bounds the scan.
 */
export async function networkingNotificationsPage(
  eventId: string,
  profileId: string,
  since: Date,
  afterId: string | null,
  limit: number,
  db: DbExecutor = getDb(),
) {
  return db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.profileId, profileId),
        eq(notifications.eventId, eventId),
        gte(notifications.createdAt, since),
        afterId === null ? undefined : gt(notifications.id, afterId),
      ),
    )
    .orderBy(asc(notifications.id))
    .limit(limit);
}
