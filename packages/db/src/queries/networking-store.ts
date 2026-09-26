import { setTimeout as sleep } from "node:timers/promises";
import { and, eq, getTableColumns, isNull, inArray, notInArray, or, sql, lt, gt, gte, count, type AnyColumn } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { getDb, type Db, type DbExecutor } from "../client";
import { isSerializationFailure } from "../txn";
import * as n from "../schema/networking";
import { events } from "../schema/events-access";
import { registrations } from "../schema/registrations";
import { forms } from "../schema/forms";
import { networkingSecondFactors } from "../schema/networking-mfa";
import { NETWORKING_MEETING_GROUPS } from "./networking-meetings";
import { listedProfile, sameIdentity } from "../policy/networking-eligibility";
import { bufferNetworkingNotices, publishNetworkingNotices, type NetworkingNotice } from "./networking-notices";
import {
  loadNetworkingCounterpartSnapshot,
  loadNetworkingParticipantSnapshot,
  loadNetworkingProfileCounterparts,
  loadNetworkingSignInCandidates,
} from "./networking-access-snapshot";
import type { NetworkingConfig } from "@app/contracts";
const tables = {
  secondFactors: networkingSecondFactors,
  configs: n.networkingConfigs,
  profiles: n.networkingProfiles,
  challenges: n.networkingChallenges,
  sessions: n.networkingSessions,
  interests: n.networkingInterests,
  connections: n.networkingConnections,
  messages: n.networkingMessages,
  blocks: n.networkingBlocks,
  reports: n.networkingReports,
  tables: n.networkingTables,
  spaces: n.networkingSpaces,
  availability: n.networkingAvailability,
  meetings: n.networkingMeetings,
  reservations: n.networkingReservations,
  notifications: n.networkingNotifications,
  deliveries: n.networkingDeliveries,
  pushSubscriptions: n.networkingPushSubscriptions,
  audit: n.networkingAudit,
  events,
  registrations,
  forms,
};
// Early-completed and no-show meetings keep holding their participants, table and exhibitor.
const RELEASED_MEETING_STATUSES = NETWORKING_MEETING_GROUPS.released;
export type NetworkingEntity = keyof typeof tables;
export type NetworkingRow<K extends NetworkingEntity> =
  (typeof tables)[K]["$inferSelect"];
export type NetworkingInsert<K extends NetworkingEntity> =
  (typeof tables)[K]["$inferInsert"];
type Where<K extends NetworkingEntity> = Partial<NetworkingRow<K>>;
function assertScopedMutationWhere(
  operation: "update" | "delete",
  where: Record<string, unknown>,
) {
  if (!Object.keys(where).length) {
    throw new Error(`Scoped ${operation} required`);
  }
  if (Object.values(where).some((value) => value === undefined)) {
    throw new Error(`Scoped ${operation} cannot contain undefined predicates`);
  }
}

function condition<K extends NetworkingEntity>(name: K, where: Where<K>) {
  const columns = getTableColumns(tables[name]) as Record<string, AnyColumn>;
  return and(
    ...Object.entries(where)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => {
        if (!columns[key])
          throw new Error(`Unknown networking query field ${key}`);
        return value === null ? isNull(columns[key]) : eq(columns[key], value);
      }),
  );
}
const HOUR_MS = 3_600_000;
/** A meeting never spans more than a day; a larger request is a caller bug, not a lock plan. */
const MAX_ALLOCATION_BUCKETS = 48;
export type NetworkingInterval = { startsAt: Date; endsAt: Date };
/** UTC hour starts overlapped by the half-open intervals, ascending and deduplicated. */
export function networkingAllocationBuckets(intervals: readonly NetworkingInterval[]): Date[] {
  const buckets = new Set<number>();
  for (const { startsAt, endsAt } of intervals) {
    const start = startsAt.getTime(), end = endsAt.getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      throw new Error("Allocation intervals must be non-empty time ranges");
    for (let hour = Math.floor(start / HOUR_MS) * HOUR_MS; hour < end; hour += HOUR_MS) {
      buckets.add(hour);
      if (buckets.size > MAX_ALLOCATION_BUCKETS)
        throw new Error(`Allocation intervals span more than ${MAX_ALLOCATION_BUCKETS} hours`);
    }
  }
  return [...buckets].sort((a, b) => a - b).map((hour) => new Date(hour));
}
/**
 * A networking write ran out of serialization retries. The API maps it to
 * 503 NETWORKING_BUSY with Retry-After; nothing was committed.
 */
export class NetworkingBusyError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Networking is busy; retry shortly", options);
    this.name = "NetworkingBusyError";
  }
}
/**
 * A resource claim fell outside the hours its allocation transaction locked,
 * e.g. the meeting moved between the caller's pre-read and the lock. Nothing
 * was committed; the caller re-plans the lock from a fresh read.
 */
export class NetworkingAllocationLockError extends Error {
  constructor() {
    super("Resource claim is outside the locked allocation hours");
    this.name = "NetworkingAllocationLockError";
  }
}
/**
 * Retry budget for networking SERIALIZABLE transactions. withSerializableTxn's
 * five attempts are too few on PostgreSQL: every waiter on a hot allocation
 * hour fails with 40001 once the holder commits, and SSI's page-level
 * predicate locks also abort some writes by distinct participants (ten
 * concurrent writers needed up to six attempts in the concurrency suite).
 * The backoff is capped, so the whole budget waits at most about 4.5 s.
 */
export const NETWORKING_TXN_ATTEMPTS = 12;
const NETWORKING_RETRY_BASE_MS = 20;
const NETWORKING_RETRY_CAP_MS = 400;
function networkingRetryDelay(attempt: number) {
  const ceiling = Math.min(NETWORKING_RETRY_BASE_MS * 2 ** (attempt - 1), NETWORKING_RETRY_CAP_MS);
  return ceiling / 2 + Math.random() * ceiling;
}
type NetworkingTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/**
 * One SERIALIZABLE transaction on one pool connection, retried on 40001/40P01.
 * Invariants live in unique indexes, so no event row is locked. When the
 * budget runs out the last serialization failure becomes NetworkingBusyError.
 */
async function networkingSerializable<T>(run: (db: NetworkingTx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    let notices: NetworkingNotice[] = [];
    try {
      const result = await getDb().transaction(
        (tx) => {
          notices = bufferNetworkingNotices(tx);
          return run(tx);
        },
        { isolationLevel: "serializable" },
      );
      // After commit: participant notices written by this attempt (4.3).
      publishNetworkingNotices(notices);
      return result;
    } catch (error) {
      if (!isSerializationFailure(error)) throw error;
      if (attempt >= NETWORKING_TXN_ATTEMPTS) throw new NetworkingBusyError({ cause: error });
      await sleep(networkingRetryDelay(attempt));
    }
  }
}
type NetworkingStoreOptions = { allocationBuckets?: readonly Date[] };
/** Narrow repository shared by networking services; all mutations require explicit scope predicates. */
export function networkingStore(db: DbExecutor = getDb(), options: NetworkingStoreOptions = {}) {
  const locked = new Set(options.allocationBuckets?.map((bucket) => bucket.getTime()));
  return {
    /** The connection or transaction this store runs on, for helpers outside the store. */
    executor: db,
    /** The participant's own listed profiles (same identity, 4.6) in the client's events. */
    async personalAnalyticsProfiles(clientId: string, email: string) {
      return db.select({ id: n.networkingProfiles.id, eventId: events.id,
        name: events.name, startDate: events.startDate, endDate: events.endDate })
        .from(n.networkingProfiles).innerJoin(events, eq(events.id, n.networkingProfiles.eventId))
        .where(and(eq(events.clientId, clientId), sameIdentity(n.networkingProfiles, email), listedProfile(n.networkingProfiles)));
    },
    /** Aggregates in SQL; contacts are deduplicated by the same lower(trim(email)) normalization. */
    async personalAnalyticsCounts(eventId: string, profileIds: string[]) {
      const p = n.networkingProfiles, a = n.networkingAudit, c = n.networkingConnections;
      const m = n.networkingMessages, meetings = n.networkingMeetings;
      const counted = (value: ReturnType<typeof sql>) => sql<number>`coalesce(${value},0)::int`.mapWith(Number);
      const [[views], [contacts], [sent], [meetingCounts]] = await Promise.all([
        db.select({ count: count() }).from(a).where(and(eq(a.eventId, eventId), eq(a.action, "PROFILE_VIEW"), inArray(a.targetId, profileIds))),
        db.select({ count: counted(sql`count(DISTINCT coalesce(nullif(lower(trim(${p.email})),''),${p.id}))`) }).from(c)
          .innerJoin(p, and(eq(p.eventId, c.eventId), eq(p.id, sql`case when ${inArray(c.profileAId, profileIds)} then ${c.profileBId} else ${c.profileAId} end`)))
          .where(and(eq(c.eventId, eventId), or(inArray(c.profileAId, profileIds), inArray(c.profileBId, profileIds)), notInArray(p.id, profileIds))),
        db.select({ count: count() }).from(m).where(and(eq(m.eventId, eventId), inArray(m.senderId, profileIds))),
        db.select({
          planned: counted(sql`count(CASE WHEN ${inArray(meetings.status, [...NETWORKING_MEETING_GROUPS.booked])} THEN 1 END)`),
          completed: counted(sql`count(CASE WHEN ${meetings.status}='COMPLETED' THEN 1 END)`),
        }).from(meetings)
          .where(and(eq(meetings.eventId, eventId), or(inArray(meetings.requesterId, profileIds), inArray(meetings.recipientId, profileIds)))),
      ]);
      return {
        profileViews: Number(views?.count ?? 0),
        matches: contacts?.count ?? 0,
        sentMessages: Number(sent?.count ?? 0),
        plannedMeetings: meetingCounts?.planned ?? 0,
        completedMeetings: meetingCounts?.completed ?? 0,
      };
    },
    async insertAvailability(values: NetworkingInsert<"availability">[]) {
      for (let offset = 0; offset < values.length; offset += 500)
        await db.insert(n.networkingAvailability).values(values.slice(offset, offset + 500));
    },
    async calendarMeetings(eventId: string, start: Date, end: Date, filters: { status?: string; tableId?: string }) {
      const m = n.networkingMeetings;
      // Start-day convention matches the organizer list and calendar's start-slot grouping.
      return db.select().from(m).where(and(eq(m.eventId, eventId),
        gte(m.startsAt, start), lt(m.startsAt, end),
        filters.status ? sql`${m.status}::text = ${filters.status}` : undefined,
        filters.tableId ? eq(m.tableId, filters.tableId) : undefined))
        .orderBy(m.startsAt, m.id).limit(5001);
    },
    async calendarRelations(eventId: string, meetings: NetworkingRow<"meetings">[]) {
      const profileIds = [...new Set(meetings.flatMap(row => [row.requesterId, row.recipientId]))];
      const tableIds = [...new Set(meetings.flatMap(row => row.tableId ? [row.tableId] : []))];
      const tableRows = tableIds.length ? await db.select().from(n.networkingTables)
        .where(and(eq(n.networkingTables.eventId, eventId), inArray(n.networkingTables.id, tableIds))) : [];
      const allProfileIds = [...new Set([...profileIds, ...tableRows.flatMap(row => row.ownerProfileId ? [row.ownerProfileId] : [])])];
      const spaceIds = [...new Set(tableRows.flatMap(row => row.spaceId ? [row.spaceId] : []))];
      const [profiles, spaces] = await Promise.all([
        allProfileIds.length ? db.select().from(n.networkingProfiles).where(and(eq(n.networkingProfiles.eventId, eventId),
          or(inArray(n.networkingProfiles.id, allProfileIds), inArray(n.networkingProfiles.standTableId, tableIds)))) : [],
        spaceIds.length ? db.select().from(n.networkingSpaces)
          .where(and(eq(n.networkingSpaces.eventId, eventId), inArray(n.networkingSpaces.id, spaceIds))) : [],
      ]);
      return { profiles, tables: tableRows, spaces };
    },
    /** The meetings' tables, each with its space, in one statement (list hydration, 4.9). */
    async meetingPlaces(eventId: string, meetings: Pick<NetworkingRow<"meetings">, "tableId">[]) {
      const tableIds = [...new Set(meetings.flatMap(row => row.tableId ? [row.tableId] : []))];
      if (!tableIds.length) return [];
      const t = n.networkingTables, s = n.networkingSpaces;
      return db.select({ table: t, space: s }).from(t)
        .leftJoin(s, and(eq(s.id, t.spaceId), eq(s.eventId, t.eventId)))
        .where(and(eq(t.eventId, eventId), inArray(t.id, tableIds)));
    },
    /** The event's profiles with these ids, in one statement. */
    async profilesByIds(eventId: string, ids: readonly string[]) {
      if (!ids.length) return [];
      return db.select().from(n.networkingProfiles)
        .where(and(eq(n.networkingProfiles.eventId, eventId), inArray(n.networkingProfiles.id, [...new Set(ids)])));
    },
    /** The viewer and the targets it may see in `profile` mode, in one statement (4.9). */
    profileCounterparts(input: Parameters<typeof loadNetworkingProfileCounterparts>[0]) {
      return loadNetworkingProfileCounterparts(input, db);
    },
    async allocationMeetings(eventId: string, startsAt: Date, endsAt: Date) {
      const m = n.networkingMeetings;
      return db.select().from(m).where(and(eq(m.eventId, eventId),
        notInArray(m.status, [...RELEASED_MEETING_STATUSES]),
        lt(m.startsAt, endsAt), gt(m.endsAt, startsAt)));
    },
    async allocationReservations(eventId: string, startsAt: Date, endsAt: Date, resourceKey?: string) {
      const r = n.networkingReservations, m = n.networkingMeetings;
      return db.select(getTableColumns(r)).from(r).innerJoin(m, eq(m.id, r.meetingId))
        .where(and(eq(r.eventId, eventId), eq(m.eventId, eventId),
          notInArray(m.status, [...RELEASED_MEETING_STATUSES]),
          gte(r.startsAt, startsAt), lt(r.startsAt, endsAt),
          resourceKey === undefined ? undefined : eq(r.resourceKey, resourceKey)));
    },
    /**
     * Failed OTP verification attempts for one (event, normalized email), summed
     * across challenges created since `dailySince`; `recent` counts only those
     * created since `recentSince`. The successful attempt (verified_at) is excluded.
     * Served by networking_challenges_email_created_idx (event_id, email, created_at).
     */
    async failedOtpAttempts(eventId: string, email: string, recentSince: Date, dailySince: Date) {
      const c = n.networkingChallenges;
      const failed = sql`(${c.attempts} - CASE WHEN ${c.verifiedAt} IS NULL THEN 0 ELSE 1 END)`;
      const [row] = await db
        .select({
          recent: sql<string | number>`COALESCE(SUM(CASE WHEN ${gte(c.createdAt, recentSince)} THEN ${failed} ELSE 0 END), 0)`,
          daily: sql<string | number>`COALESCE(SUM(${failed}), 0)`,
        })
        .from(c)
        .where(and(eq(c.eventId, eventId), eq(c.email, email), gte(c.createdAt, dailySince)));
      return { recent: Number(row?.recent ?? 0), daily: Number(row?.daily ?? 0) };
    },
    async allocationTableUsage(eventId: string) {
      const m = n.networkingMeetings;
      return db.select({ tableId: m.tableId, count: count() }).from(m)
        .where(and(eq(m.eventId, eventId), inArray(m.status, [...NETWORKING_MEETING_GROUPS.holding])))
        .groupBy(m.tableId);
    },
    /**
     * Claim one resource for every quantum in one statement. All-or-nothing:
     * a conflicting quantum (unique resource/slot index) undoes the rows this
     * call inserted and returns false, so the caller can try another table
     * without aborting the transaction. Only inside the hours the allocation
     * transaction locked.
     */
    async claimResource(eventId: string, meetingId: string, resourceKey: string, quanta: readonly Date[]) {
      if (!quanta.length) return true;
      if (quanta.some((quantum) => !locked.has(Math.floor(quantum.getTime() / HOUR_MS) * HOUR_MS)))
        throw new NetworkingAllocationLockError();
      const r = n.networkingReservations;
      const inserted = await db.insert(r)
        .values(quanta.map((startsAt) => ({ eventId, meetingId, resourceKey, startsAt })))
        .onConflictDoNothing({ target: [r.eventId, r.resourceKey, r.startsAt] })
        .returning({ id: r.id });
      if (inserted.length === quanta.length) return true;
      if (inserted.length)
        await db.delete(r).where(and(eq(r.eventId, eventId), inArray(r.id, inserted.map((row) => row.id))));
      return false;
    },
    /**
     * The unrevoked session whose token hash is any of `hashes`: the keyring's
     * candidates for one bearer token (current format first, then older keys).
     */
    async sessionByTokenHashes(eventId: string, hashes: readonly string[]) {
      if (!hashes.length) return null;
      const t = n.networkingSessions;
      const [row] = await db.select().from(t)
        .where(and(eq(t.eventId, eventId), isNull(t.revokedAt), inArray(t.tokenHash, [...hashes])))
        .limit(1);
      return row ?? null;
    },
    /** Moves a session found under an older key to the current hash; a no-op if another request already did. */
    async rehashSession(eventId: string, id: string, from: string, to: string) {
      const t = n.networkingSessions;
      await db.update(t).set({ tokenHash: to })
        .where(and(eq(t.eventId, eventId), eq(t.id, id), eq(t.tokenHash, from)));
    },
    /** Participant access facts in one statement (4.6); see `loadNetworkingParticipantSnapshot`. */
    participantSnapshot(input: { eventId: string; clientId: string; profileId: string; sessionId?: string }) {
      return loadNetworkingParticipantSnapshot(input, db);
    },
    /** A sign-in address's profiles with their access facts, oldest first (4.6). */
    signInCandidates(eventId: string, email: string, config: NetworkingConfig) {
      return loadNetworkingSignInCandidates(eventId, email, config, db);
    },
    /** Viewer, target, registrations, block and connection in one statement (4.6). */
    counterpartSnapshot(input: { eventId: string; viewerId: string; targetId: string }) {
      return loadNetworkingCounterpartSnapshot(input, db);
    },
    /** Revokes the live session a bearer token names, under any of its candidate hashes. */
    async revokeSessionByTokenHashes(eventId: string, hashes: readonly string[]) {
      if (!hashes.length) return;
      const t = n.networkingSessions;
      await db.update(t).set({ revokedAt: new Date() })
        .where(and(eq(t.eventId, eventId), isNull(t.revokedAt), inArray(t.tokenHash, [...hashes])));
    },
    /** Swipe upsert on the (event, profile, target) pair; returns the stored row. */
    async upsertInterest(eventId: string, profileId: string, targetId: string, action: "LIKE" | "PASS") {
      const i = n.networkingInterests;
      const [row] = await db.insert(i).values({ eventId, profileId, targetId, action })
        .onConflictDoUpdate({
          target: [i.eventId, i.profileId, i.targetId],
          set: { action: sql`excluded.action`, updatedAt: new Date() },
        })
        .returning();
      return row;
    },
    /**
     * The pair's connection, created if absent; `created` is true only for the
     * inserting call. The pair may come in either order: it is stored smaller
     * id first, as networking_connections_ordered_pair requires (the same
     * comparison as networkingPair).
     */
    async ensureConnection(eventId: string, firstId: string, secondId: string) {
      if (firstId === secondId) throw new Error("A connection needs two different profiles");
      const [profileAId, profileBId] = firstId < secondId ? [firstId, secondId] : [secondId, firstId];
      const c = n.networkingConnections;
      const [created] = await db.insert(c).values({ eventId, profileAId, profileBId })
        .onConflictDoNothing({ target: [c.eventId, c.profileAId, c.profileBId] })
        .returning();
      if (created) return { connection: created, created: true };
      const [existing] = await db.select().from(c)
        .where(and(eq(c.eventId, eventId), eq(c.profileAId, profileAId), eq(c.profileBId, profileBId)));
      return { connection: existing, created: false };
    },
    /** A message keyed by (sender, clientMessageId); null when that key already exists. */
    async insertMessageOnce(value: NetworkingInsert<"messages">) {
      const m = n.networkingMessages;
      const [row] = await db.insert(m).values(value)
        .onConflictDoNothing({ target: [m.senderId, m.clientMessageId] })
        .returning();
      return row ?? null;
    },
    /** Idempotent block edge on the (event, profile, target) pair. */
    async insertBlockOnce(eventId: string, profileId: string, targetId: string) {
      const b = n.networkingBlocks;
      await db.insert(b).values({ eventId, profileId, targetId })
        .onConflictDoNothing({ target: [b.eventId, b.profileId, b.targetId] });
    },
    /** A push endpoint belongs to the last participant that subscribed it (unique endpoint). */
    async upsertPushSubscription(value: NetworkingInsert<"pushSubscriptions">) {
      const p = n.networkingPushSubscriptions;
      const [row] = await db.insert(p).values(value)
        .onConflictDoUpdate({
          target: p.endpoint,
          set: {
            eventId: sql`excluded.event_id`,
            profileId: sql`excluded.profile_id`,
            keys: sql`excluded.keys`,
            expirationTime: sql`excluded.expiration_time`,
          },
        })
        .returning();
      return row;
    },
    async all<K extends NetworkingEntity>(
      name: K,
      where: Where<K>,
    ): Promise<NetworkingRow<K>[]> {
      // SAFETY: The table selected by name defines NetworkingRow<K>; Drizzle loses that generic correlation.
      return (await db
        .select()
        .from(tables[name] as PgTable)
        .where(condition(name, where))) as unknown as NetworkingRow<K>[];
    },
    async one<K extends NetworkingEntity>(
      name: K,
      where: Where<K>,
    ): Promise<NetworkingRow<K> | null> {
      const rows = await db
        .select()
        .from(tables[name] as PgTable)
        .where(condition(name, where))
        .limit(1);
      // SAFETY: Rows come from the table selected by K above.
      return (rows[0] as unknown as NetworkingRow<K>) ?? null;
    },
    async insert<K extends NetworkingEntity>(
      name: K,
      value: NetworkingInsert<K>,
    ): Promise<NetworkingRow<K>> {
      const rows = await db
        .insert(tables[name] as PgTable)
        .values(value)
        .returning();
      // SAFETY: INSERT RETURNING uses the table selected by K above.
      return rows[0] as unknown as NetworkingRow<K>;
    },
    async update<K extends NetworkingEntity>(
      name: K,
      where: Where<K>,
      value: Partial<NetworkingInsert<K>>,
    ): Promise<NetworkingRow<K>[]> {
      assertScopedMutationWhere("update", where);
      // SAFETY: The table selected by name defines NetworkingRow<K>; Drizzle loses that generic correlation.
      return (await db
        .update(tables[name] as PgTable)
        .set(value)
        .where(condition(name, where))
        .returning()) as unknown as NetworkingRow<K>[];
    },
    async remove<K extends NetworkingEntity>(name: K, where: Where<K>) {
      assertScopedMutationWhere("delete", where);
      await db.delete(tables[name] as PgTable).where(condition(name, where));
    },
  };
}
export type NetworkingStore = ReturnType<typeof networkingStore>;
/**
 * A networking write: SERIALIZABLE, retried, one pool connection. Every helper
 * called inside `run` must use `store`/`db`; a second connection deadlocks a
 * small pool. `eventId` names the event the write belongs to.
 */
export function networkingTransaction<T>(
  _eventId: string,
  run: (store: NetworkingStore, db: DbExecutor) => Promise<T>,
): Promise<T> {
  return networkingSerializable((db) => run(networkingStore(db), db));
}
/**
 * A networking write that claims participants, tables or stands. Its first
 * statement upserts one networking_allocation_locks row per UTC hour the
 * intervals overlap (ascending, in one statement), so competing allocations
 * for overlapping times serialize there. Only claims inside those hours are
 * allowed (store.claimResource throws NetworkingAllocationLockError otherwise).
 */
export async function networkingAllocationTransaction<T>(
  eventId: string,
  intervals: readonly NetworkingInterval[],
  run: (store: NetworkingStore, db: DbExecutor) => Promise<T>,
): Promise<T> {
  const buckets = networkingAllocationBuckets(intervals);
  if (!buckets.length) throw new Error("An allocation needs at least one interval");
  const l = n.networkingAllocationLocks;
  return networkingSerializable(async (db) => {
    await db
      .insert(l)
      .values(buckets.map((bucketStart) => ({ eventId, bucketStart })))
      .onConflictDoUpdate({ target: [l.eventId, l.bucketStart], set: { lockedAt: sql`now()` } });
    return run(networkingStore(db, { allocationBuckets: buckets }), db);
  });
}
