import { and, eq, getTableColumns, isNull, inArray, notInArray, or, sql, lt, gt, gte, count, type AnyColumn } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { getDb, type DbExecutor } from "../client";
import { withSerializableTxn } from "../txn";
import * as n from "../schema/networking";
import { events } from "../schema/events-access";
import { registrations } from "../schema/registrations";
import { forms } from "../schema/forms";
import { networkingSecondFactors } from "../schema/networking-mfa";
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
const RELEASED_MEETING_STATUSES = ["CANCELLED", "DECLINED", "EXPIRED"] as const;
export type NetworkingEntity = keyof typeof tables;
export type NetworkingRow<K extends NetworkingEntity> =
  (typeof tables)[K]["$inferSelect"];
export type NetworkingInsert<K extends NetworkingEntity> =
  (typeof tables)[K]["$inferInsert"];
type Where<K extends NetworkingEntity> = Partial<NetworkingRow<K>>;
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
/** Narrow repository shared by networking services; all mutations require explicit scope predicates. */
export function networkingStore(db: DbExecutor = getDb()) {
  return {
    async personalAnalyticsProfiles(clientId: string, email: string) {
      return db.select({ id: n.networkingProfiles.id, eventId: events.id,
        name: events.name, startDate: events.startDate, endDate: events.endDate })
        .from(n.networkingProfiles).innerJoin(events, eq(events.id, n.networkingProfiles.eventId))
        .where(and(eq(events.clientId, clientId), sql`lower(trim(${n.networkingProfiles.email})) = ${email}`));
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
          planned: counted(sql`count(CASE WHEN ${meetings.status} IN ('CONFIRMED','COMPLETED','NO_SHOW') THEN 1 END)`),
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
        .where(and(eq(m.eventId, eventId), inArray(m.status, ["PENDING", "CONFIRMED", "PENDING_ALLOCATION", "COMPLETED"])))
        .groupBy(m.tableId);
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
      if (!Object.keys(where).length) throw new Error("Scoped update required");
      // SAFETY: The table selected by name defines NetworkingRow<K>; Drizzle loses that generic correlation.
      return (await db
        .update(tables[name] as PgTable)
        .set(value)
        .where(condition(name, where))
        .returning()) as unknown as NetworkingRow<K>[];
    },
    async remove<K extends NetworkingEntity>(name: K, where: Where<K>) {
      if (!Object.keys(where).length) throw new Error("Scoped delete required");
      await db.delete(tables[name] as PgTable).where(condition(name, where));
    },
  };
}
export type NetworkingStore = ReturnType<typeof networkingStore>;
export function networkingTransaction<T>(
  eventId: string,
  run: (store: NetworkingStore, db: DbExecutor) => Promise<T>,
): Promise<T> {
  return withSerializableTxn(async (db) => {
    // Lock one event to serialize mutual matching and resource allocation across API replicas.
    await db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.id, eventId))
      .for("update");
    return run(networkingStore(db), db);
  });
}
