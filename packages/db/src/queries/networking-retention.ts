import { eq, getTableName, inArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { createLogger } from "@app/shared";
import { getDb, type DbExecutor } from "../client";
import { rowCountOf, rowsOf } from "../helpers";
import { withSerializableTxn } from "../txn";
import * as n from "../schema/networking";
import { networkingEmbeddingJobs, networkingEmbeddings } from "../schema/networking-embeddings";
import { networkingSecondFactors } from "../schema/networking-mfa";
import { emailLogs } from "../schema/email";
import { enqueueNetworkingPhotoDeletes } from "./storage-delete";

const log = createLogger({ name: "db:networking-retention" });
const DAY_MS = 86_400_000;

/** Rows per purge statement: small enough for a short transaction on either engine. */
export const NETWORKING_PURGE_BATCH_SIZE = 500;
/** Audit rows that survive the purge: the aggregate post-event report (counts only, no participant). */
export const NETWORKING_PURGE_KEPT_AUDIT_ACTIONS = ["POST_EVENT_REPORT"] as const;

/** The instant networking data of an event may no longer be kept. */
export function networkingRetentionEndsAt(endDate: Date, retentionDays: number) {
  return new Date(endDate.getTime() + retentionDays * DAY_MS);
}
export function networkingRetentionEnded(endDate: Date, retentionDays: number, now = Date.now()) {
  return now > networkingRetentionEndsAt(endDate, retentionDays).getTime();
}

type PurgeBatch = (db: DbExecutor, eventId: string, limit: number) => Promise<number>;
export interface NetworkingPurgeStep {
  /** Stable name for logs and results (the SQL table name). */
  name: string;
  table: PgTable;
  batch: PurgeBatch;
}

/** Up to `limit` rows of the event, by primary key. */
function eventRows(table: PgTable, key: PgColumn, event: PgColumn, extra: SQL = sql`TRUE`): PurgeBatch {
  return async (db, eventId, limit) => rowCountOf(await db.execute(sql`
    DELETE FROM ${table} WHERE ${key} IN (
      SELECT ${key} FROM ${table} WHERE ${event}=${eventId} AND ${extra} LIMIT ${limit}
    )`));
}
/** Up to `limit` rows keyed by a profile of the event (tables without an event_id). */
function profileRows(table: PgTable, profileKey: PgColumn): PurgeBatch {
  const profiles = n.networkingProfiles;
  return async (db, eventId, limit) => rowCountOf(await db.execute(sql`
    DELETE FROM ${table} WHERE ${profileKey} IN (
      SELECT ${profileKey} FROM ${table} WHERE ${profileKey} IN (
        SELECT ${profiles.id} FROM ${profiles} WHERE ${profiles.eventId}=${eventId}
      ) LIMIT ${limit}
    )`));
}
/** Profiles last: each batch queues its photos' deletion in the same transaction. */
const profileBatch: PurgeBatch = (_db, eventId, limit) => withSerializableTxn(async (tx) => {
  const profiles = n.networkingProfiles;
  const batch = await tx
    .select({ id: profiles.id, eventId: profiles.eventId, photoUrl: profiles.photoUrl })
    .from(profiles)
    .where(eq(profiles.eventId, eventId))
    .limit(limit);
  if (!batch.length) return 0;
  await enqueueNetworkingPhotoDeletes(tx, batch, "networking.retention");
  await tx.delete(profiles).where(inArray(profiles.id, batch.map((profile) => profile.id)));
  return batch.length;
});
const locks = n.networkingAllocationLocks;
/** Composite key (event_id, bucket_start): the outer delete stays scoped to the event. */
const lockBatch: PurgeBatch = async (db, eventId, limit) => rowCountOf(await db.execute(sql`
  DELETE FROM ${locks} WHERE ${locks.eventId}=${eventId} AND ${locks.bucketStart} IN (
    SELECT ${locks.bucketStart} FROM ${locks} WHERE ${locks.eventId}=${eventId} LIMIT ${limit}
  )`));
const logs = emailLogs;
/** Networking email logs of the event (index email_logs_networking_event_idx, 0026). */
const emailLogBatch: PurgeBatch = async (db, eventId, limit) => rowCountOf(await db.execute(sql`
  DELETE FROM ${logs} WHERE ${logs.id} IN (
    SELECT ${logs.id} FROM ${logs}
    WHERE (${logs.contextSnapshot} ->> 'dispatchOwner') = 'networking' AND (${logs.contextSnapshot} ->> 'eventId') = ${eventId}
    LIMIT ${limit}
  )`));

/**
 * Every networking table, children before parents so no batch cascades into
 * an unbounded delete, and meetings before the tables they restrict. The
 * config row stays: it carries the purge state and holds no participant data.
 * A purge-completeness test derives the networking tables from the Drizzle
 * schema and fails when one is neither here nor kept.
 */
export const NETWORKING_PURGE_STEPS: readonly NetworkingPurgeStep[] = [
  { table: n.networkingReservations, batch: eventRows(n.networkingReservations, n.networkingReservations.id, n.networkingReservations.eventId) },
  { table: n.networkingMeetings, batch: eventRows(n.networkingMeetings, n.networkingMeetings.id, n.networkingMeetings.eventId) },
  { table: n.networkingReports, batch: eventRows(n.networkingReports, n.networkingReports.id, n.networkingReports.eventId) },
  { table: n.networkingMessages, batch: eventRows(n.networkingMessages, n.networkingMessages.id, n.networkingMessages.eventId) },
  { table: n.networkingConnections, batch: eventRows(n.networkingConnections, n.networkingConnections.id, n.networkingConnections.eventId) },
  { table: n.networkingInterests, batch: eventRows(n.networkingInterests, n.networkingInterests.id, n.networkingInterests.eventId) },
  { table: n.networkingBlocks, batch: eventRows(n.networkingBlocks, n.networkingBlocks.id, n.networkingBlocks.eventId) },
  { table: n.networkingAvailability, batch: eventRows(n.networkingAvailability, n.networkingAvailability.id, n.networkingAvailability.eventId) },
  { table: n.networkingNotifications, batch: eventRows(n.networkingNotifications, n.networkingNotifications.id, n.networkingNotifications.eventId) },
  { table: n.networkingDeliveries, batch: eventRows(n.networkingDeliveries, n.networkingDeliveries.id, n.networkingDeliveries.eventId) },
  { table: n.networkingPushSubscriptions, batch: eventRows(n.networkingPushSubscriptions, n.networkingPushSubscriptions.id, n.networkingPushSubscriptions.eventId) },
  { table: n.networkingSessions, batch: eventRows(n.networkingSessions, n.networkingSessions.id, n.networkingSessions.eventId) },
  { table: n.networkingChallenges, batch: eventRows(n.networkingChallenges, n.networkingChallenges.id, n.networkingChallenges.eventId) },
  { table: networkingEmbeddings, batch: eventRows(networkingEmbeddings, networkingEmbeddings.id, networkingEmbeddings.eventId) },
  { table: networkingEmbeddingJobs, batch: profileRows(networkingEmbeddingJobs, networkingEmbeddingJobs.profileId) },
  { table: networkingSecondFactors, batch: profileRows(networkingSecondFactors, networkingSecondFactors.profileId) },
  { table: n.networkingTables, batch: eventRows(n.networkingTables, n.networkingTables.id, n.networkingTables.eventId) },
  { table: n.networkingSpaces, batch: eventRows(n.networkingSpaces, n.networkingSpaces.id, n.networkingSpaces.eventId) },
  { table: locks, batch: lockBatch },
  {
    table: n.networkingAudit,
    batch: eventRows(n.networkingAudit, n.networkingAudit.id, n.networkingAudit.eventId,
      sql`${n.networkingAudit.action} NOT IN (${sql.join(NETWORKING_PURGE_KEPT_AUDIT_ACTIONS.map((action) => sql`${action}`), sql`,`)})`),
  },
  { table: n.networkingProfiles, batch: profileBatch },
  { table: logs, batch: emailLogBatch },
].map((step) => ({ ...step, name: getTableName(step.table) }));
/** Networking tables the purge keeps on purpose (no participant data). */
export const NETWORKING_PURGE_KEPT_TABLES: readonly PgTable[] = [n.networkingConfigs];

export interface NetworkingPurgeResult {
  eventId: string;
  /** False when the deadline stopped it; the next call resumes where it left off. */
  done: boolean;
  deleted: Record<string, number>;
}

/**
 * Remove every networking row of an event, `batchSize` rows per statement, in
 * short transactions. Resumable: the first call disables the config and
 * stamps `purge_started_at`; `purged_at` is stamped only once every step has
 * drained. Profile photos are queued for durable deletion with their rows.
 * `onBatch` sees every batch's count (operator scripts log them).
 */
export async function purgeNetworkingEvent(
  eventId: string,
  options: {
    batchSize?: number;
    /** Epoch ms; checked before every batch. */
    deadline?: number;
    onBatch?: (table: string, deleted: number) => void;
  } = {},
): Promise<NetworkingPurgeResult> {
  const db = getDb();
  const batchSize = options.batchSize ?? NETWORKING_PURGE_BATCH_SIZE;
  const deleted: Record<string, number> = {};
  // Disabling first closes participant access and stops sync from creating
  // profiles; admin re-enabling is refused once the purge has started.
  await db.execute(sql`
    UPDATE networking_configs
    SET config=jsonb_set(config,'{enabled}','false'::jsonb),purge_started_at=COALESCE(purge_started_at,now()),updated_at=now()
    WHERE event_id=${eventId} AND (purge_started_at IS NULL OR config->>'enabled'='true')`);
  for (const step of NETWORKING_PURGE_STEPS) {
    for (;;) {
      if (options.deadline !== undefined && Date.now() >= options.deadline)
        return { eventId, done: false, deleted };
      const count = await step.batch(db, eventId, batchSize);
      if (count) deleted[step.name] = (deleted[step.name] ?? 0) + count;
      options.onBatch?.(step.name, count);
      if (count < batchSize) break;
    }
  }
  await db.execute(sql`UPDATE networking_configs SET purged_at=now() WHERE event_id=${eventId}`);
  return { eventId, done: true, deleted };
}

/**
 * Events past retention that still need a purge: never purged (or interrupted),
 * or purged but holding profiles again. In-progress purges resume first.
 */
export async function networkingEventsToPurge(eventId?: string): Promise<string[]> {
  return (await networkingPurgeCandidates(eventId)).map((row) => row.eventId);
}

export interface NetworkingPurgeCandidate {
  eventId: string;
  endDate: Date;
  retentionDays: number;
  purgeStartedAt: Date | null;
  purgedAt: Date | null;
  profiles: number;
}
/** `networkingEventsToPurge` with what an operator needs to review before a manual purge. */
export async function networkingPurgeCandidates(eventId?: string): Promise<NetworkingPurgeCandidate[]> {
  const date = (value: Date | string | null) => (value === null ? null : new Date(value));
  return rowsOf<{
    event_id: string; end_date: Date | string; retention_days: number;
    purge_started_at: Date | string | null; purged_at: Date | string | null; profiles: number;
  }>(await getDb().execute(sql`
    SELECT c.event_id, e.end_date, COALESCE((c.config->>'retentionDays')::int,90) AS retention_days,
      c.purge_started_at, c.purged_at,
      (SELECT count(*)::int4 FROM networking_profiles p WHERE p.event_id=c.event_id) AS profiles
    FROM networking_configs c JOIN events e ON e.id=c.event_id
    WHERE e.end_date+COALESCE((c.config->>'retentionDays')::int,90)*interval '1 day'<now()
      AND (c.purged_at IS NULL OR EXISTS (SELECT 1 FROM networking_profiles p WHERE p.event_id=c.event_id))
      ${eventId ? sql`AND c.event_id=${eventId}` : sql``}
    ORDER BY c.purge_started_at IS NULL, c.purge_started_at, c.event_id`)).map((row) => ({
    eventId: row.event_id,
    endDate: new Date(row.end_date),
    retentionDays: Number(row.retention_days),
    purgeStartedAt: date(row.purge_started_at),
    purgedAt: date(row.purged_at),
    profiles: Number(row.profiles),
  }));
}

/** Networking email logs whose event no longer exists (event deletion does not cascade to them). */
const orphanEmailLogs = sql`(${logs.contextSnapshot} ->> 'dispatchOwner') = 'networking'
  AND NOT EXISTS (SELECT 1 FROM events e WHERE e.id = (${logs.contextSnapshot} ->> 'eventId'))`;
export async function countOrphanNetworkingEmailLogs(): Promise<number> {
  return Number(rowsOf<{ n: number }>(await getDb().execute(sql`SELECT count(*)::int4 AS n FROM ${logs} WHERE ${orphanEmailLogs}`))[0]?.n ?? 0);
}
/** Operator script (purge-leftovers): deletes them in batches, reporting each batch. */
export async function purgeOrphanNetworkingEmailLogs(options: {
  batchSize?: number;
  onBatch?: (deleted: number) => void;
} = {}): Promise<number> {
  const batchSize = options.batchSize ?? NETWORKING_PURGE_BATCH_SIZE;
  let total = 0;
  for (;;) {
    const count = rowCountOf(await getDb().execute(sql`
      DELETE FROM ${logs} WHERE ${logs.id} IN (SELECT ${logs.id} FROM ${logs} WHERE ${orphanEmailLogs} LIMIT ${batchSize})`));
    total += count;
    options.onBatch?.(count);
    if (count < batchSize) return total;
  }
}

/** Maintenance: purge expired events within a time budget; the next run resumes. */
export async function purgeExpiredNetworkingEvents(options: { eventId?: string; budgetMs?: number; batchSize?: number } = {}) {
  const deadline = Date.now() + (options.budgetMs ?? 45_000);
  const results: NetworkingPurgeResult[] = [];
  for (const eventId of await networkingEventsToPurge(options.eventId)) {
    if (Date.now() >= deadline) break;
    const result = await purgeNetworkingEvent(eventId, { deadline, batchSize: options.batchSize });
    results.push(result);
    log.info({ eventId, done: result.done, deleted: result.deleted }, "Networking retention purge");
    if (!result.done) break;
  }
  return results;
}
