import { sql, type SQL } from "drizzle-orm";
import { createLogger, makeWorkerId } from "@app/shared";
import type { AppEvent } from "@app/contracts";
import { getDb, type DbExecutor } from "../client";
import { rowsOf } from "../helpers";
import { auditLogs, outboxEvents } from "../schema";
import {
  DB_NOW,
  createLeaseQueue,
  intervalMs,
  runLeased,
  type LeaseQueue,
  type LeaseQueueSpec,
} from "../lease-queue";
import {
  REALTIME_EMIT_TYPE,
  type OutboxHandlerRegistry,
  type OutboxHandlerResult,
  type OutboxProcessingScope,
} from "./types";

const logger = createLogger({ name: "db:outbox" });

const OUTBOX_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_WORKER_ID = makeWorkerId("outbox");

export interface EnqueueOutboxInput {
  type: string;
  payload: unknown;
  aggregateType?: string;
  aggregateId?: string;
  clientId?: string;
  eventId?: string;
  dedupeKey?: string;
  maxAttempts?: number;
}

export interface ProcessOutboxOptions {
  handlers: OutboxHandlerRegistry;
  workerId?: string;
  leaseMs?: number;
  scope?: OutboxProcessingScope;
  /**
   * Job signal (timeout or shutdown): no new row starts, and claimed rows not
   * finished are released without an attempt penalty. Handlers get it in
   * their meta.
   */
  signal?: AbortSignal;
}

export interface ProcessOutboxResult {
  processed: number;
  skipped: number;
  failed: number;
  leaseLost: number;
  /** Claimed rows put back unprocessed after an abort (no attempt charged). */
  released: number;
}

interface ClaimedOutboxRow {
  id: string;
  type: string;
  payload: unknown;
  attemptCount: number;
  maxAttempts: number;
}

// Serialize payloads exactly like the legacy `JSON.parse(JSON.stringify(v))`:
// strips undefined / functions / symbols, yields plain JSON for the jsonb column.
function toJsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Retry backoff (step function keyed on the POST-increment attempt count).
// ---------------------------------------------------------------------------
function outboxRetryDelayMs(attemptCount: number): number {
  if (attemptCount <= 1) return 30 * 1000;
  if (attemptCount === 2) return 2 * 60 * 1000;
  if (attemptCount === 3) return 5 * 60 * 1000;
  return 15 * 60 * 1000;
}

// The scope clause is built from a fixed constant, never user input, so raw
// interpolation is safe.
function outboxScopeClause(scope: OutboxProcessingScope): SQL {
  if (scope === "realtime")
    return sql.raw(`AND "type" = '${REALTIME_EMIT_TYPE}'`);
  if (scope === "background")
    return sql.raw(`AND "type" <> '${REALTIME_EMIT_TYPE}'`);
  return sql.raw("");
}

/**
 * outbox_events as a lease queue. PENDING/FAILED rows that are due and under
 * max_attempts are claimable (FIFO by created_at); PROCESSING is the lease.
 * A released row goes back to FAILED if it had been attempted before, else
 * PENDING. Recovery requeues expired leases as FAILED, due now
 * (next_attempt_at NULL), or dead-letters them once attempts are exhausted.
 */
function outboxLeaseSpec(scope: OutboxProcessingScope = "all"): LeaseQueueSpec {
  return {
    name: `outbox:${scope}`,
    table: "outbox_events",
    leasedStatus: "PROCESSING",
    leaseMs: OUTBOX_LEASE_MS,
    claimable: sql`"status" IN ('PENDING', 'FAILED')
      AND ("next_attempt_at" IS NULL OR "next_attempt_at" <= ${DB_NOW})
      AND "attempt_count" < "max_attempts"
      ${outboxScopeClause(scope)}`,
    order: sql`"created_at" ASC`,
    claimSet: sql`"error_message" = NULL`,
    releaseSet: sql`"status" = CASE WHEN "attempt_count" > 1 THEN 'FAILED' ELSE 'PENDING' END,
      "next_attempt_at" = NULL`,
    recovery: {
      exhausted: sql`"attempt_count" >= "max_attempts"`,
      retrySet: sql`"status" = 'FAILED', "next_attempt_at" = NULL`,
      deadSet: sql`"status" = 'DEAD_LETTERED', "next_attempt_at" = NULL`,
    },
  };
}

/**
 * The whole outbox as one queue. The worker's LeaseRecoveryJob recovers it,
 * realtime rows leased by an API pump included.
 */
export const outboxQueue = createLeaseQueue(outboxLeaseSpec("all"));
const scopedQueues: Record<OutboxProcessingScope, LeaseQueue> = {
  all: outboxQueue,
  realtime: createLeaseQueue(outboxLeaseSpec("realtime")),
  background: createLeaseQueue(outboxLeaseSpec("background")),
};

// ---------------------------------------------------------------------------
// Enqueue — rides the CALLER's transaction (that atomicity is the whole point
// of the outbox pattern), hence the DbExecutor param instead of owning a txn.
//
// Dedupe is one statement: ON CONFLICT on the partial unique index
// `outbox_events_dedupe_key_key` (0001_raw_indexes.sql). The index predicate is
// repeated so PostgreSQL can infer that index. A duplicate key inserts nothing
// and raises nothing, so the caller's transaction stays usable (no savepoint
// needed; a failed statement would abort the whole transaction, 25P02) and a
// concurrent duplicate waits for the first writer instead of failing.
// ---------------------------------------------------------------------------
export async function enqueueOutboxEvent(
  exec: DbExecutor,
  input: EnqueueOutboxInput,
): Promise<boolean> {
  const inserted = await exec
    .insert(outboxEvents)
    .values({
      type: input.type,
      aggregateType: input.aggregateType ?? null,
      aggregateId: input.aggregateId ?? null,
      clientId: input.clientId ?? null,
      eventId: input.eventId ?? null,
      dedupeKey: input.dedupeKey ?? null,
      payload: toJsonValue(input.payload),
      maxAttempts: input.maxAttempts ?? 5,
    })
    .onConflictDoNothing({
      target: outboxEvents.dedupeKey,
      where: sql.raw(`"dedupe_key" IS NOT NULL`),
    })
    .returning({ id: outboxEvents.id });
  if (inserted.length === 0) {
    logger.info(
      { type: input.type, dedupeKey: input.dedupeKey },
      "Outbox event already enqueued, skipping duplicate",
    );
    return false;
  }
  return true;
}

/** Audit-log insert. Rides the caller's transaction via the DbExecutor param. */
export async function insertAuditLog(
  values: typeof auditLogs.$inferInsert,
  exec: DbExecutor = getDb(),
): Promise<void> {
  await exec.insert(auditLogs).values(values);
}

let realtimeDisabled = false;

export interface OutboxConfig {
  /** REALTIME_DISABLED: nothing drains realtime.emit rows, so none are written. */
  realtimeDisabled: boolean;
}

/**
 * Process-wide outbox settings from the app config. Both apps call it at
 * startup (realtime events are produced in the api and in the worker);
 * unconfigured tools and tests keep realtime enabled.
 */
export function configureOutbox(config: OutboxConfig): void {
  realtimeDisabled = config.realtimeDisabled;
}

/**
 * Realtime fan-out enqueue: maxAttempts 10 (a dropped live UI event is
 * costly). A no-op returning false when realtime is disabled: no api pump
 * would ever drain the row.
 */
export async function enqueueRealtimeOutboxEvent(
  exec: DbExecutor,
  payload: AppEvent,
  dedupeKey?: string,
): Promise<boolean> {
  if (realtimeDisabled) return false;
  return enqueueOutboxEvent(exec, {
    type: REALTIME_EMIT_TYPE,
    payload,
    aggregateType: payload.type,
    aggregateId: String(payload.payload.id),
    clientId: payload.clientId,
    eventId: payload.eventId,
    dedupeKey,
    maxAttempts: 10,
  });
}

// Terminal writes go through the queue's ownership guard (status PROCESSING
// and locked_by): if recovery took the row mid-flight the write misses and
// runLeased records a lost lease instead of clobbering the new owner.
function outboxDoneSet(status: "PROCESSED" | "SKIPPED"): SQL {
  return sql`"status" = ${status}, "processed_at" = ${DB_NOW}, "error_message" = NULL,
    "next_attempt_at" = NULL`;
}

// attemptCount already includes this claim (post-increment).
function outboxFailedSet(row: ClaimedOutboxRow, error: unknown): SQL {
  const message = error instanceof Error ? error.message : String(error);
  if (row.attemptCount >= row.maxAttempts) {
    return sql`"status" = 'DEAD_LETTERED', "error_message" = ${message}, "next_attempt_at" = NULL`;
  }
  return sql`"status" = 'FAILED', "error_message" = ${message},
    "next_attempt_at" = ${DB_NOW} + ${intervalMs(outboxRetryDelayMs(row.attemptCount))}`;
}

/**
 * Claim up to `batchSize` due rows of `scope` and run each through its
 * handler via runLeased: one heartbeat renews every unfinished row, each
 * row's ownership is confirmed right before its handler, and an abort
 * releases the rows not started without an attempt penalty. Unknown types
 * fail and retry like any handler error.
 */
export async function processOutboxEvents(
  batchSize = 50,
  options: ProcessOutboxOptions,
): Promise<ProcessOutboxResult> {
  let processed = 0;
  let skipped = 0;
  const { handlers } = options;
  const workerId = options.workerId ?? DEFAULT_WORKER_ID;
  const queue = scopedQueues[options.scope ?? "all"];

  const run = await runLeased<ClaimedOutboxRow>(queue, {
    workerId,
    limit: batchSize,
    signal: options.signal,
    leaseMs: options.leaseMs,
    load: async (ids) =>
      rowsOf<ClaimedOutboxRow>(
        await getDb().execute(sql`
          SELECT "id", "type", "payload",
                 "attempt_count" AS "attemptCount",
                 "max_attempts" AS "maxAttempts"
          FROM "outbox_events"
          WHERE "id" IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
            AND "status" = 'PROCESSING' AND "locked_by" = ${workerId}
          ORDER BY "created_at" ASC
        `),
      ),
    handle: async (event, { signal }) => {
      const handler = handlers[event.type];
      if (!handler) {
        throw new Error(`Unknown outbox event type: ${event.type}`);
      }
      const outcome: OutboxHandlerResult = await handler(event.payload, {
        id: event.id,
        signal,
      });
      const status = outcome === "skipped" ? "SKIPPED" : "PROCESSED";
      const written = await queue.complete(workerId, event.id, outboxDoneSet(status));
      if (written && status === "SKIPPED") skipped++;
      else if (written) processed++;
      return written;
    },
    onError: async (event, error) => {
      logger.error(
        { err: error, outboxEventId: event.id, type: event.type },
        "Outbox event processing failed",
      );
      return queue.fail(workerId, event.id, outboxFailedSet(event, error));
    },
  });
  return {
    processed,
    skipped,
    failed: run.failed,
    leaseLost: run.leaseLost,
    released: run.released,
  };
}

// ----------------------------------------------------------------------------
// Outbox health (ops /health/outbox)
// ----------------------------------------------------------------------------

const OUTBOX_UNHEALTHY_AGE_MS = 10 * 60 * 1000; // 10min
const OUTBOX_UNHEALTHY_SIZE = 1000;
/** Only recent dead letters make the outbox unhealthy; older ones were seen already. */
const OUTBOX_RECENT_DEAD_LETTER_MS = 24 * 60 * 60 * 1000;

export interface OutboxHealth {
  isHealthy: boolean;
  counts: {
    pending: number;
    failed: number;
    processing: number;
    /** Every dead-lettered row still in the table. */
    deadLettered: number;
    /** Rows dead-lettered in the last 24 h (the only ones that flag the outbox). */
    deadLetteredLast24h: number;
  };
  oldestPendingAgeMs: number;
  oldestProcessingAgeMs: number;
}

export async function getOutboxHealth(): Promise<OutboxHealth> {
  const db = getDb();

  // Ages computed in SQL (now() - col) so they never JS-parse a naive timestamp
  // string from db.execute (which node-postgres would misread as process-local
  // on non-UTC hosts). EXTRACT(EPOCH FROM interval) is a pure wall-clock diff,
  // TZ-independent. A dead letter's time is its last write (updated_at): every
  // lease-queue write that dead-letters a row sets it.
  const [countsRes, oldestPendingRes, lease] = await Promise.all([
    db.execute(sql`
      SELECT "status", COUNT(*)::int AS n,
        COALESCE(SUM(CASE WHEN "status" = 'DEAD_LETTERED'
          AND "updated_at" >= ${DB_NOW} - ${intervalMs(OUTBOX_RECENT_DEAD_LETTER_MS)}
          THEN 1 ELSE 0 END), 0)::int AS recent
      FROM "outbox_events"
      WHERE "status" IN ('PENDING', 'FAILED', 'PROCESSING', 'DEAD_LETTERED')
      GROUP BY "status"
    `),
    db.execute(sql`
      SELECT COALESCE(EXTRACT(EPOCH FROM (now() - MIN("created_at"))) * 1000, 0)::float8 AS age
      FROM "outbox_events" WHERE "status" IN ('PENDING', 'FAILED')
    `),
    outboxQueue.health(),
  ]);

  const counts = { pending: 0, failed: 0, processing: 0, deadLettered: 0, deadLetteredLast24h: 0 };
  for (const row of rowsOf<{ status: string; n: number; recent: number }>(countsRes)) {
    if (row.status === "PENDING") counts.pending = Number(row.n);
    else if (row.status === "FAILED") counts.failed = Number(row.n);
    else if (row.status === "PROCESSING") counts.processing = Number(row.n);
    else if (row.status === "DEAD_LETTERED") {
      counts.deadLettered = Number(row.n);
      counts.deadLetteredLast24h = Number(row.recent ?? 0);
    }
  }

  const ageOf = (res: unknown): number =>
    Math.round(Number(rowsOf<{ age: number | string }>(res)[0]?.age ?? 0));
  const oldestPendingAgeMs = ageOf(oldestPendingRes);
  const oldestProcessingAgeMs = lease.oldestLeaseAgeMs;

  const isHealthy =
    counts.deadLetteredLast24h === 0 &&
    counts.pending + counts.failed < OUTBOX_UNHEALTHY_SIZE &&
    oldestPendingAgeMs < OUTBOX_UNHEALTHY_AGE_MS &&
    oldestProcessingAgeMs < 2 * OUTBOX_LEASE_MS;

  return {
    isHealthy,
    counts,
    oldestPendingAgeMs,
    oldestProcessingAgeMs,
  };
}
