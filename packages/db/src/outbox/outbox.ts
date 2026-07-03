import { sql, type SQL } from "drizzle-orm";
import { createLogger, makeWorkerId } from "@app/shared";
import type { AppEvent } from "@app/contracts";
import { getDb, type DbExecutor } from "../client";
import { rowsOf, rowCountOf } from "../helpers";
import { pgUniqueViolation } from "../txn";
import { auditLogs, outboxEvents } from "../schema";
import {
  REALTIME_EMIT_TYPE,
  type OutboxHandlerRegistry,
  type OutboxHandlerResult,
  type OutboxProcessingScope,
} from "./types";

const logger = createLogger({ name: "db:outbox" });

const OUTBOX_LEASE_MS = 5 * 60 * 1000;
const OUTBOX_RECOVERY_INTERVAL_MS = 60 * 1000;
const DEFAULT_WORKER_ID = makeWorkerId("outbox");

// Module-level, per-process: recovery runs at most once per minute, piggybacked
// on whichever processOutboxEvents call ticks first.
let lastRecoveryAt = 0;

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
}

export interface ProcessOutboxResult {
  processed: number;
  skipped: number;
  failed: number;
  leaseLost: number;
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

function nextOutboxAttemptAt(attemptCount: number, from = new Date()): Date {
  return new Date(from.getTime() + outboxRetryDelayMs(attemptCount));
}

// The scope clause is built from a fixed constant, never user input, so raw
// interpolation is safe and matches the legacy claim SQL byte-for-byte.
function outboxScopeClause(scope: OutboxProcessingScope): SQL {
  if (scope === "realtime")
    return sql.raw(`AND "type" = '${REALTIME_EMIT_TYPE}'`);
  if (scope === "background")
    return sql.raw(`AND "type" <> '${REALTIME_EMIT_TYPE}'`);
  return sql.raw("");
}

// A drizzle transaction executor exposes rollback(); the root db does not. Used
// to decide whether a failed dedupe insert needs a SAVEPOINT to avoid poisoning
// the caller's transaction.
function isTransactionExecutor(exec: DbExecutor): boolean {
  return typeof (exec as { rollback?: unknown }).rollback === "function";
}

// outbox_events has exactly one caller-supplied unique index (the partial
// dedupe_key index `outbox_events_dedupe_key_key`), so any 23505 raised while a
// dedupe key is present is the idempotency race, whether or not the driver
// surfaces the constraint name.
function isOutboxDedupeViolation(error: unknown, dedupeKey?: string): boolean {
  const v = pgUniqueViolation(error);
  if (v === null) return false;
  if (v.constraint.includes("outbox_events_dedupe_key_key")) return true;
  return dedupeKey != null;
}

// ---------------------------------------------------------------------------
// Enqueue — rides the CALLER's transaction (that atomicity is the whole point
// of the outbox pattern), hence the DbExecutor param instead of owning a txn.
// ---------------------------------------------------------------------------
export async function enqueueOutboxEvent(
  exec: DbExecutor,
  input: EnqueueOutboxInput,
): Promise<boolean> {
  try {
    if (input.dedupeKey) {
      const existing = await exec
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(sql`${outboxEvents.dedupeKey} = ${input.dedupeKey}`)
        .limit(1);
      if (existing[0]) {
        logger.info(
          { type: input.type, dedupeKey: input.dedupeKey },
          "Outbox event already enqueued, skipping duplicate",
        );
        return false;
      }
    }

    const useSavepoint =
      input.dedupeKey != null && isTransactionExecutor(exec);
    if (useSavepoint) {
      await exec.execute(sql.raw("SAVEPOINT outbox_enqueue_dedupe"));
    }

    try {
      await exec.insert(outboxEvents).values({
        type: input.type,
        aggregateType: input.aggregateType ?? null,
        aggregateId: input.aggregateId ?? null,
        clientId: input.clientId ?? null,
        eventId: input.eventId ?? null,
        dedupeKey: input.dedupeKey ?? null,
        payload: toJsonValue(input.payload),
        maxAttempts: input.maxAttempts ?? 5,
      });
      if (useSavepoint) {
        await exec.execute(sql.raw("RELEASE SAVEPOINT outbox_enqueue_dedupe"));
      }
    } catch (error) {
      if (useSavepoint) {
        await exec.execute(
          sql.raw("ROLLBACK TO SAVEPOINT outbox_enqueue_dedupe"),
        );
        await exec.execute(sql.raw("RELEASE SAVEPOINT outbox_enqueue_dedupe"));
      }
      throw error;
    }
    return true;
  } catch (error) {
    if (isOutboxDedupeViolation(error, input.dedupeKey)) {
      logger.info(
        { type: input.type, dedupeKey: input.dedupeKey },
        "Outbox event already enqueued, skipping duplicate",
      );
      return false;
    }
    throw error;
  }
}

/** Audit-log insert. Rides the caller's transaction via the DbExecutor param. */
export async function insertAuditLog(
  values: typeof auditLogs.$inferInsert,
  exec: DbExecutor = getDb(),
): Promise<void> {
  await exec.insert(auditLogs).values(values);
}

/** Realtime fan-out enqueue: maxAttempts 10 (a dropped live UI event is costly). */
export async function enqueueRealtimeOutboxEvent(
  exec: DbExecutor,
  payload: AppEvent,
  dedupeKey?: string,
): Promise<boolean> {
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

// ---------------------------------------------------------------------------
// Stale-lease recovery — reclaims rows whose worker died mid-processing once
// their lease (`locked_until`) expires.
// ---------------------------------------------------------------------------
export async function recoverStaleOutboxLeases(
  now = new Date(),
): Promise<{ requeued: number; deadLettered: number }> {
  const requeued = rowCountOf(
    await getDb().execute(sql`
      UPDATE "outbox_events"
      SET "status" = 'FAILED', "next_attempt_at" = ${now},
          "locked_at" = NULL, "locked_until" = NULL, "locked_by" = NULL
      WHERE "status" = 'PROCESSING'
        AND "locked_until" < ${now}
        AND "attempt_count" < "max_attempts"
    `),
  );

  const deadLettered = rowCountOf(
    await getDb().execute(sql`
      UPDATE "outbox_events"
      SET "status" = 'DEAD_LETTERED', "next_attempt_at" = NULL,
          "locked_at" = NULL, "locked_until" = NULL, "locked_by" = NULL
      WHERE "status" = 'PROCESSING'
        AND "locked_until" < ${now}
        AND "attempt_count" >= "max_attempts"
    `),
  );

  if (requeued > 0 || deadLettered > 0) {
    logger.warn({ requeued, deadLettered }, "Recovered stale outbox leases");
  }
  return { requeued, deadLettered };
}

// Terminal writes are guarded by `status='PROCESSING' AND locked_by=workerId` —
// if a stale-lease recovery reclaimed the row mid-flight the update misses (0
// rows) and the caller records a lease-loss instead of clobbering the new owner.
async function markOutboxProcessed(
  id: string,
  status: "PROCESSED" | "SKIPPED",
  workerId: string,
): Promise<boolean> {
  const now = new Date();
  const res = await getDb().execute(sql`
    UPDATE "outbox_events"
    SET "status" = ${status}, "processed_at" = ${now}, "error_message" = NULL,
        "next_attempt_at" = NULL, "locked_at" = NULL, "locked_until" = NULL,
        "locked_by" = NULL
    WHERE "id" = ${id} AND "status" = 'PROCESSING' AND "locked_by" = ${workerId}
    RETURNING "id"
  `);
  return rowCountOf(res) > 0;
}

async function markOutboxFailed(
  id: string,
  workerId: string,
  attemptCount: number,
  maxAttempts: number,
  error: unknown,
): Promise<boolean> {
  const now = new Date();
  const shouldDeadLetter = attemptCount >= maxAttempts;
  const status = shouldDeadLetter ? "DEAD_LETTERED" : "FAILED";
  const message = error instanceof Error ? error.message : String(error);
  const nextAttemptAt = shouldDeadLetter
    ? null
    : nextOutboxAttemptAt(attemptCount, now);
  const res = await getDb().execute(sql`
    UPDATE "outbox_events"
    SET "status" = ${status}, "error_message" = ${message},
        "last_attempt_at" = ${now}, "next_attempt_at" = ${nextAttemptAt},
        "locked_at" = NULL, "locked_until" = NULL, "locked_by" = NULL
    WHERE "id" = ${id} AND "status" = 'PROCESSING' AND "locked_by" = ${workerId}
    RETURNING "id"
  `);
  return rowCountOf(res) > 0;
}

// Renew the lease periodically so long-running handlers aren't reclaimed as
// stale mid-flight. Timer is unref'd (never holds the loop open) and stopped in
// the caller's finally regardless of outcome.
function startOutboxLeaseRenewal(
  id: string,
  workerId: string,
  leaseMs: number,
): () => void {
  const renewEveryMs = Math.max(1_000, Math.floor(leaseMs / 2));
  const timer = setInterval(() => {
    const until = new Date(Date.now() + leaseMs);
    void getDb()
      .execute(sql`
        UPDATE "outbox_events" SET "locked_until" = ${until}
        WHERE "id" = ${id} AND "status" = 'PROCESSING'
          AND "locked_by" = ${workerId}
      `)
      .catch((err: unknown) => {
        logger.warn({ err, outboxEventId: id }, "Outbox lease renewal failed");
      });
  }, renewEveryMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

function recordLeaseLost(
  result: ProcessOutboxResult,
  id: string,
  workerId: string,
  status: string,
): void {
  result.leaseLost++;
  logger.warn(
    { outboxEventId: id, workerId, status },
    "Outbox event lease was lost before status update",
  );
}

export async function processOutboxEvents(
  batchSize = 50,
  options: ProcessOutboxOptions,
): Promise<ProcessOutboxResult> {
  const result: ProcessOutboxResult = {
    processed: 0,
    skipped: 0,
    failed: 0,
    leaseLost: 0,
  };
  const { handlers } = options;
  const workerId = options.workerId ?? DEFAULT_WORKER_ID;
  const leaseMs = options.leaseMs ?? OUTBOX_LEASE_MS;
  const scope = options.scope ?? "all";
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + leaseMs);
  const scopeClause = outboxScopeClause(scope);

  if (now.getTime() - lastRecoveryAt >= OUTBOX_RECOVERY_INTERVAL_MS) {
    lastRecoveryAt = now.getTime();
    await recoverStaleOutboxLeases(now);
  }

  // Single atomic claim: UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP
  // LOCKED). FIFO by created_at; only due + under-cap PENDING/FAILED rows.
  const claimed = await getDb().execute(sql`
    UPDATE "outbox_events"
    SET "status" = 'PROCESSING', "updated_at" = ${now}, "locked_at" = ${now},
        "locked_until" = ${lockedUntil}, "locked_by" = ${workerId},
        "last_attempt_at" = ${now}, "attempt_count" = "attempt_count" + 1,
        "error_message" = NULL
    WHERE "id" IN (
      SELECT "id" FROM "outbox_events"
       WHERE "status" IN ('PENDING', 'FAILED')
         AND ("next_attempt_at" IS NULL OR "next_attempt_at" <= ${now})
         AND "attempt_count" < "max_attempts"
         ${scopeClause}
       ORDER BY "created_at" ASC
       LIMIT ${batchSize}
       FOR UPDATE SKIP LOCKED
    )
    RETURNING "id"
  `);

  const ids = rowsOf<{ id: string }>(claimed).map((row) => row.id);
  if (ids.length === 0) return result;

  const idList = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  const events = rowsOf<ClaimedOutboxRow>(
    await getDb().execute(sql`
      SELECT "id", "type", "payload",
             "attempt_count" AS "attemptCount",
             "max_attempts" AS "maxAttempts"
      FROM "outbox_events"
      WHERE "id" IN (${idList}) AND "status" = 'PROCESSING'
        AND "locked_by" = ${workerId}
      ORDER BY "created_at" ASC
    `),
  );

  for (const event of events) {
    const stopRenewal = startOutboxLeaseRenewal(event.id, workerId, leaseMs);
    try {
      const handler = handlers[event.type];
      if (!handler) {
        throw new Error(`Unknown outbox event type: ${event.type}`);
      }
      const outcome: OutboxHandlerResult = await handler(event.payload);
      if (outcome === "skipped") {
        const marked = await markOutboxProcessed(event.id, "SKIPPED", workerId);
        if (marked) result.skipped++;
        else recordLeaseLost(result, event.id, workerId, "SKIPPED");
      } else {
        const marked = await markOutboxProcessed(
          event.id,
          "PROCESSED",
          workerId,
        );
        if (marked) result.processed++;
        else recordLeaseLost(result, event.id, workerId, "PROCESSED");
      }
    } catch (error) {
      logger.error(
        { err: error, outboxEventId: event.id, type: event.type },
        "Outbox event processing failed",
      );
      const marked = await markOutboxFailed(
        event.id,
        workerId,
        event.attemptCount,
        event.maxAttempts,
        error,
      );
      if (marked) result.failed++;
      else recordLeaseLost(result, event.id, workerId, "FAILED");
    } finally {
      stopRenewal();
    }
  }

  return result;
}

// ----------------------------------------------------------------------------
// Outbox health (ops /health/outbox)
// ----------------------------------------------------------------------------

const OUTBOX_UNHEALTHY_AGE_MS = 10 * 60 * 1000; // 10min
const OUTBOX_UNHEALTHY_SIZE = 1000;

export interface OutboxHealth {
  isHealthy: boolean;
  counts: {
    pending: number;
    failed: number;
    processing: number;
    deadLettered: number;
  };
  oldestPendingAgeMs: number;
  oldestProcessingAgeMs: number;
}

export async function getOutboxHealth(): Promise<OutboxHealth> {
  const db = getDb();

  // Ages computed in SQL (now() - col) so they never JS-parse a naive timestamp
  // string from db.execute (which node-postgres would misread as process-local
  // on non-UTC hosts). EXTRACT(EPOCH FROM interval) is a pure wall-clock diff,
  // TZ-independent.
  const [countsRes, oldestPendingRes, oldestProcessingRes] = await Promise.all([
    db.execute(sql`
      SELECT "status", COUNT(*)::int AS n FROM "outbox_events"
      WHERE "status" IN ('PENDING', 'FAILED', 'PROCESSING', 'DEAD_LETTERED')
      GROUP BY "status"
    `),
    db.execute(sql`
      SELECT COALESCE(EXTRACT(EPOCH FROM (now() - MIN("created_at"))) * 1000, 0)::float8 AS age
      FROM "outbox_events" WHERE "status" IN ('PENDING', 'FAILED')
    `),
    db.execute(sql`
      SELECT COALESCE(EXTRACT(EPOCH FROM (now() - MIN(COALESCE("locked_at", "updated_at")))) * 1000, 0)::float8 AS age
      FROM "outbox_events" WHERE "status" = 'PROCESSING'
    `),
  ]);

  const counts = { pending: 0, failed: 0, processing: 0, deadLettered: 0 };
  for (const row of rowsOf<{ status: string; n: number }>(countsRes)) {
    if (row.status === "PENDING") counts.pending = Number(row.n);
    else if (row.status === "FAILED") counts.failed = Number(row.n);
    else if (row.status === "PROCESSING") counts.processing = Number(row.n);
    else if (row.status === "DEAD_LETTERED")
      counts.deadLettered = Number(row.n);
  }

  const ageOf = (res: unknown): number =>
    Math.round(Number(rowsOf<{ age: number | string }>(res)[0]?.age ?? 0));
  const oldestPendingAgeMs = ageOf(oldestPendingRes);
  const oldestProcessingAgeMs = ageOf(oldestProcessingRes);

  const isHealthy =
    counts.deadLettered === 0 &&
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
