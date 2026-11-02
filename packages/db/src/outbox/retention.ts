import { sql, type SQL } from "drizzle-orm";
import { getDb } from "../client";
import { rowCountOf } from "../helpers";
import { DB_NOW, intervalMs } from "../lease-queue";
import { REALTIME_OUTBOX_TYPES } from "./types";

const HOUR_MS = 60 * 60 * 1000;

/** Outbox retention windows (worker RetentionJob, hourly). */
export const OUTBOX_RETENTION = {
  /** Realtime fan-out rows: a live UI event is worthless after a day. */
  realtimeMaxAgeMs: 24 * HOUR_MS,
  /** Finished background rows without a dedupe key. */
  backgroundMaxAgeMs: 30 * 24 * HOUR_MS,
  /** Finished keyed rows are compacted (payload `{}`) after this, never deleted. */
  keyedCompactAfterMs: 30 * 24 * HOUR_MS,
  /** Rows per statement: short statements, short locks. */
  batchSize: 1_000,
} as const;

export interface OutboxRetentionOptions {
  /** Stop between batches once aborted (job timeout or shutdown). */
  signal?: AbortSignal;
  batchSize?: number;
  realtimeMaxAgeMs?: number;
  backgroundMaxAgeMs?: number;
  keyedCompactAfterMs?: number;
}

export interface OutboxRetentionResult {
  /** Realtime-scoped rows (`REALTIME_OUTBOX_TYPES`) deleted (older than 24 h, not leased). */
  realtimeDeleted: number;
  /** Finished unkeyed background rows deleted (older than 30 d). */
  backgroundDeleted: number;
  /** Finished keyed rows whose payload was replaced by `{}` (older than 30 d). */
  compacted: number;
}

// Fixed constants, never user input: `'realtime.emit', 'networking.notify'`.
const REALTIME = sql.raw(REALTIME_OUTBOX_TYPES.map((type) => `'${type}'`).join(", "));

/**
 * Unkeyed realtime rows (admin `realtime.emit` events and IDs-only
 * `networking.notify` notices) older than the window, leased rows excepted.
 * Any other status goes: a realtime event still pending after a day (realtime
 * disabled, pump down) would only replay a stale UI refresh. Keyed rows are
 * never deleted (none are realtime today).
 */
function realtimeExpired(maxAgeMs: number): SQL {
  return sql`"type" IN (${REALTIME}) AND "dedupe_key" IS NULL
    AND "status" <> 'PROCESSING'
    AND "created_at" < ${DB_NOW} - ${intervalMs(maxAgeMs)}`;
}

/**
 * Finished unkeyed background rows older than the window. Dead letters stay
 * (requeue-dead-letters); pending/failed rows are live work.
 */
function backgroundExpired(maxAgeMs: number): SQL {
  return sql`"type" NOT IN (${REALTIME}) AND "dedupe_key" IS NULL
    AND "status" IN ('PROCESSED', 'SKIPPED')
    AND "created_at" < ${DB_NOW} - ${intervalMs(maxAgeMs)}`;
}

/**
 * Finished keyed rows older than the window whose payload is still there. The
 * row itself stays forever so its dedupe_key keeps rejecting duplicates.
 */
function keyedCompactable(afterMs: number): SQL {
  return sql`"dedupe_key" IS NOT NULL
    AND "status" IN ('PROCESSED', 'SKIPPED')
    AND "created_at" < ${DB_NOW} - ${intervalMs(afterMs)}
    AND "payload" <> '{}'::jsonb`;
}

// One batch: pick up to `limit` matching rows (skipping rows another
// transaction holds), then act on those still matching. The predicate is
// repeated on the outer statement so a row that changed after the pick (e.g.
// claimed) is re-checked, not acted on.
function pick(where: SQL, limit: number): SQL {
  return sql`SELECT "id" FROM "outbox_events" WHERE ${where} LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
}

async function deleteBatch(where: SQL, limit: number): Promise<number> {
  return rowCountOf(
    await getDb().execute(sql`
      DELETE FROM "outbox_events"
      WHERE "id" IN (${pick(where, limit)}) AND ${where}
    `),
  );
}

async function compactBatch(where: SQL, limit: number): Promise<number> {
  return rowCountOf(
    await getDb().execute(sql`
      UPDATE "outbox_events" SET "payload" = '{}'::jsonb, "updated_at" = ${DB_NOW}
      WHERE "id" IN (${pick(where, limit)}) AND ${where}
    `),
  );
}

async function inBatches(
  batch: (limit: number) => Promise<number>,
  limit: number,
  signal?: AbortSignal,
): Promise<number> {
  let total = 0;
  while (!signal?.aborted) {
    const n = await batch(limit);
    total += n;
    if (n < limit) break;
  }
  return total;
}

/**
 * One retention pass over outbox_events, in batches of `batchSize` rows (one
 * autocommit statement each) until nothing is left or the signal aborts:
 * delete realtime rows older than 24 h, delete finished unkeyed background
 * rows older than 30 d, and compact finished keyed rows older than 30 d
 * (payload `{}`; the row and its dedupe_key stay).
 */
export async function runOutboxRetention(
  options: OutboxRetentionOptions = {},
): Promise<OutboxRetentionResult> {
  const limit = options.batchSize ?? OUTBOX_RETENTION.batchSize;
  const { signal } = options;
  const realtime = realtimeExpired(options.realtimeMaxAgeMs ?? OUTBOX_RETENTION.realtimeMaxAgeMs);
  const background = backgroundExpired(options.backgroundMaxAgeMs ?? OUTBOX_RETENTION.backgroundMaxAgeMs);
  const keyed = keyedCompactable(options.keyedCompactAfterMs ?? OUTBOX_RETENTION.keyedCompactAfterMs);

  const realtimeDeleted = await inBatches((n) => deleteBatch(realtime, n), limit, signal);
  const backgroundDeleted = await inBatches((n) => deleteBatch(background, n), limit, signal);
  const compacted = await inBatches((n) => compactBatch(keyed, n), limit, signal);
  return { realtimeDeleted, backgroundDeleted, compacted };
}
