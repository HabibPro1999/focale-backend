import { and, eq, getTableColumns, isNull, inArray, or, sql, lt, gt, gte, count, type AnyColumn } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { getDb, type DbExecutor } from "../client";
import { withSerializableTxn } from "../txn";
import * as n from "../schema/networking";
import { events } from "../schema/events-access";
import { registrations } from "../schema/registrations";
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
};
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
    async personalAnalyticsRows(eventId: string, profileIds: string[]) {
      const p = n.networkingProfiles, a = n.networkingAudit, c = n.networkingConnections;
      const m = n.networkingMessages, meetings = n.networkingMeetings;
      const [audit, connections, messages, meetingRows] = await Promise.all([
        db.select({ targetId: a.targetId, action: a.action }).from(a).where(and(eq(a.eventId, eventId), eq(a.action, "PROFILE_VIEW"), inArray(a.targetId, profileIds))),
        db.select({ profileAId: c.profileAId, profileBId: c.profileBId, email: p.email }).from(c)
          .innerJoin(p, and(eq(p.eventId, c.eventId), eq(p.id, sql`case when ${inArray(c.profileAId, profileIds)} then ${c.profileBId} else ${c.profileAId} end`)))
          .where(and(eq(c.eventId, eventId), or(inArray(c.profileAId, profileIds), inArray(c.profileBId, profileIds)))),
        db.select({ senderId: m.senderId }).from(m).where(and(eq(m.eventId, eventId), inArray(m.senderId, profileIds))),
        db.select({ requesterId: meetings.requesterId, recipientId: meetings.recipientId, status: meetings.status }).from(meetings)
          .where(and(eq(meetings.eventId, eventId), or(inArray(meetings.requesterId, profileIds), inArray(meetings.recipientId, profileIds)))),
      ]);
      return { audit, connections, messages, meetings: meetingRows };
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
        inArray(m.status, ["PENDING", "CONFIRMED", "PENDING_ALLOCATION"]),
        lt(m.startsAt, endsAt), gt(m.endsAt, startsAt)));
    },
    async allocationReservations(eventId: string, startsAt: Date, endsAt: Date, resourceKey?: string) {
      const r = n.networkingReservations, m = n.networkingMeetings;
      return db.select(getTableColumns(r)).from(r).innerJoin(m, eq(m.id, r.meetingId))
        .where(and(eq(r.eventId, eventId), eq(m.eventId, eventId),
          inArray(m.status, ["PENDING", "CONFIRMED", "PENDING_ALLOCATION"]),
          gte(r.startsAt, startsAt), lt(r.startsAt, endsAt),
          resourceKey === undefined ? undefined : eq(r.resourceKey, resourceKey)));
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
