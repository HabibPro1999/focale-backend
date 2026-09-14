import { and, eq, getTableColumns, isNull, type AnyColumn } from "drizzle-orm";
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
    async all<K extends NetworkingEntity>(
      name: K,
      where: Where<K>,
    ): Promise<NetworkingRow<K>[]> {
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
      return rows[0] as unknown as NetworkingRow<K>;
    },
    async update<K extends NetworkingEntity>(
      name: K,
      where: Where<K>,
      value: Partial<NetworkingInsert<K>>,
    ): Promise<NetworkingRow<K>[]> {
      if (!Object.keys(where).length) throw new Error("Scoped update required");
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
