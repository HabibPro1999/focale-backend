/** Abstract Book jobs on the lease queue, and the queue's health read. */
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
  type InferSelectModel,
  type SQL,
} from "drizzle-orm";
import { FINAL_STATUSES } from "@app/contracts";
import { createLogger } from "@app/shared";
import { getDb, type DbExecutor } from "../../client";
import { STANDARD_RETRY_DELAYS_MS, standardRetryDelayMs } from "../../helpers";
import { DB_NOW, backoffInterval, createLeaseQueue, intervalMs } from "../../lease-queue";
import { withTxn, pgUniqueViolation } from "../../txn";
import { insertAuditLog } from "../../outbox";
import { abstractBookJobs, abstractConfig, abstracts } from "../../schema/abstracts";

// ============================================================================
// Abstract Book jobs — a lease queue (packages/db/src/lease-queue).
//
// The worker owns PDF generation and runs each job through runLeased: the
// claim uses FOR UPDATE SKIP LOCKED, a heartbeat renews the lease while the
// render runs (a lost lease aborts it), and every terminal write re-checks
// ownership (status=RUNNING AND locked_by=workerId) so a worker that lost its
// lease can't clobber another's result. Lease times come from the database
// clock; the worker's LeaseRecoveryJob recovers expired leases.
// ============================================================================

const bookLogger = createLogger({ name: "db:abstract-book" });

export type AbstractBookJobRow = InferSelectModel<typeof abstractBookJobs>;

/**
 * Worker lease (5 min). The heartbeat renews it every third of that while a
 * render runs, so a dead worker's job is recovered within minutes instead of
 * an hour.
 */
export const ABSTRACT_BOOK_LEASE_MS = 5 * 60 * 1000;

/**
 * abstract_book_jobs as a lease queue. Due PENDING jobs under max_attempts are
 * claimable (FIFO); RUNNING is the lease. A released job goes back to PENDING,
 * due now. An expired lease is requeued PENDING with the retry backoff, or
 * dead-lettered to FAILED once its attempts are used up.
 */
export const abstractBookQueue = createLeaseQueue({
  name: "abstract-book",
  table: "abstract_book_jobs",
  leasedStatus: "RUNNING",
  leaseMs: ABSTRACT_BOOK_LEASE_MS,
  claimable: sql`"status" = 'PENDING'
    AND ("next_attempt_at" IS NULL OR "next_attempt_at" <= ${DB_NOW})
    AND "attempt_count" < "max_attempts"`,
  order: sql`"created_at" ASC`,
  claimSet: sql`"started_at" = COALESCE("started_at", ${DB_NOW}), "error_message" = NULL`,
  releaseSet: sql`"status" = 'PENDING', "next_attempt_at" = NULL`,
  recovery: {
    exhausted: sql`"attempt_count" >= "max_attempts"`,
    retrySet: sql`"status" = 'PENDING',
      "next_attempt_at" = ${DB_NOW} + ${backoffInterval(sql`"attempt_count"`, STANDARD_RETRY_DELAYS_MS)},
      "error_message" = COALESCE("error_message", 'Abstract Book job lease expired; requeued for retry')`,
    deadSet: sql`"status" = 'FAILED', "completed_at" = ${DB_NOW}, "next_attempt_at" = NULL,
      "error_message" = COALESCE("error_message", 'Abstract Book job lease expired and retry limit was exhausted')`,
  },
});

export type EnqueueBookJobResult =
  | { ok: false; reason: "no_config" }
  | { ok: false; reason: "unfinished"; unfinishedCount: number }
  | { ok: true; job: AbstractBookJobRow };

const ACTIVE_BOOK_JOB_STATUSES = ["PENDING", "RUNNING"] as const;

// 23505 unique violation on the partial index enforcing one active (PENDING/
// RUNNING) book job per event (L1).
function isDuplicateActiveBookJobViolation(error: unknown): boolean {
  const v = pgUniqueViolation(error);
  return v !== null && v.constraint.includes("abstract_book_jobs_event_id_active_key");
}

async function findActiveAbstractBookJob(
  db: DbExecutor,
  eventId: string,
): Promise<AbstractBookJobRow | null> {
  const [existing] = await db
    .select()
    .from(abstractBookJobs)
    .where(
      and(
        eq(abstractBookJobs.eventId, eventId),
        inArray(abstractBookJobs.status, ACTIVE_BOOK_JOB_STATUSES),
      ),
    )
    .limit(1);
  return existing ?? null;
}

/**
 * Enqueue a PENDING book job. Gated: the AbstractConfig must exist, and there
 * must be zero abstracts still outside FINAL_STATUSES. Create + audit ride one
 * READ COMMITTED transaction. An expired RUNNING job of the event is
 * recovered first (3.4), so a dead worker never blocks a new request.
 *
 * L1: idempotent against duplicates — if a PENDING/RUNNING job already covers
 * this event, that job is returned as-is (ok:true, no new insert) instead of
 * enqueueing a second one; the partial unique index backstops the remaining
 * check-then-insert race with the same idempotent response.
 */
export async function enqueueAbstractBookJob(params: {
  eventId: string;
  requestedBy: string;
}): Promise<EnqueueBookJobResult> {
  const { eventId, requestedBy } = params;
  const db = getDb();
  const [cfgRows, unfinishedRows] = await Promise.all([
    db
      .select({ id: abstractConfig.id })
      .from(abstractConfig)
      .where(eq(abstractConfig.eventId, eventId))
      .limit(1),
    db
      .select({ n: count() })
      .from(abstracts)
      .where(
        and(
          eq(abstracts.eventId, eventId),
          notInArray(abstracts.status, FINAL_STATUSES),
        ),
      ),
  ]);
  if (!cfgRows[0]) return { ok: false, reason: "no_config" };
  const unfinishedCount = unfinishedRows[0]?.n ?? 0;
  if (unfinishedCount > 0) {
    return { ok: false, reason: "unfinished", unfinishedCount };
  }

  // A RUNNING job whose worker died would otherwise block this event until
  // the worker's lease recovery runs: recover it now (requeued, or FAILED
  // once its attempts are used up, which lets a new job start).
  const recovered = await abstractBookQueue.recoverStale(sql`"event_id" = ${eventId}`);
  if (recovered.requeued > 0 || recovered.deadLettered > 0) {
    bookLogger.warn({ eventId, ...recovered }, "Recovered an expired Abstract Book job lease on enqueue");
  }

  try {
    return await withTxn(async (tx): Promise<EnqueueBookJobResult> => {
      const existing = await findActiveAbstractBookJob(tx, eventId);
      if (existing) return { ok: true, job: existing };

      const [job] = await tx
        .insert(abstractBookJobs)
        .values({ eventId, requestedBy, status: "PENDING" })
        .returning();
      await insertAuditLog(
        {
          entityType: "AbstractBookJob",
          entityId: job.id,
          action: "enqueue",
          changes: { status: { old: null, new: "PENDING" } },
          performedBy: requestedBy,
        },
        tx,
      );
      return { ok: true, job };
    });
  } catch (error) {
    if (isDuplicateActiveBookJobViolation(error)) {
      const existing = await findActiveAbstractBookJob(db, eventId);
      if (existing) return { ok: true, job: existing };
    }
    throw error;
  }
}

/** Last 20 jobs for an event, newest first. */
export async function listAbstractBookJobs(
  eventId: string,
): Promise<AbstractBookJobRow[]> {
  return getDb()
    .select()
    .from(abstractBookJobs)
    .where(eq(abstractBookJobs.eventId, eventId))
    .orderBy(desc(abstractBookJobs.createdAt))
    .limit(20);
}

/** Single job scoped to its event; null if missing or the event mismatches. */
export async function getAbstractBookJob(
  eventId: string,
  jobId: string,
): Promise<AbstractBookJobRow | null> {
  const [job] = await getDb()
    .select()
    .from(abstractBookJobs)
    .where(eq(abstractBookJobs.id, jobId))
    .limit(1);
  if (!job || job.eventId !== eventId) return null;
  return job;
}

/**
 * The claimed jobs still leased to `workerId`, oldest first (claim ids come
 * unordered; a row taken over since the claim is left out).
 */
export async function loadClaimedAbstractBookJobs(
  ids: string[],
  workerId: string,
): Promise<AbstractBookJobRow[]> {
  if (ids.length === 0) return [];
  return getDb()
    .select()
    .from(abstractBookJobs)
    .where(
      and(
        inArray(abstractBookJobs.id, ids),
        eq(abstractBookJobs.status, "RUNNING"),
        eq(abstractBookJobs.lockedBy, workerId),
      ),
    )
    .orderBy(asc(abstractBookJobs.createdAt));
}

/** Mark COMPLETED and clear the lease, while `workerId` owns the job. False when the lease was lost. */
export async function completeAbstractBookJob(params: {
  jobId: string;
  workerId: string;
  storageKey: string;
  includedCount: number;
}): Promise<boolean> {
  return abstractBookQueue.complete(
    params.workerId,
    params.jobId,
    sql`"status" = 'COMPLETED', "storage_key" = ${params.storageKey},
      "included_count" = ${params.includedCount}, "completed_at" = ${DB_NOW},
      "error_message" = NULL, "next_attempt_at" = NULL`,
  );
}

/**
 * Fail a job: back to PENDING with backoff while attempts remain, else
 * dead-letter to FAILED. Only while `workerId` owns it; false when the lease
 * was lost. `attemptCount` includes the failed attempt.
 */
export async function failAbstractBookJob(params: {
  jobId: string;
  workerId: string;
  attemptCount: number;
  maxAttempts: number;
  message: string;
}): Promise<boolean> {
  const set =
    params.attemptCount < params.maxAttempts
      ? sql`"status" = 'PENDING', "error_message" = ${params.message}, "completed_at" = NULL,
          "next_attempt_at" = ${DB_NOW} + ${intervalMs(standardRetryDelayMs(params.attemptCount))}`
      : sql`"status" = 'FAILED', "error_message" = ${params.message}, "completed_at" = ${DB_NOW},
          "next_attempt_at" = NULL`;
  return abstractBookQueue.fail(params.workerId, params.jobId, set);
}

// ----------------------------------------------------------------------------
// Abstract Book queue health (ops /health/abstract-book-jobs)
// ----------------------------------------------------------------------------

const ABSTRACT_BOOK_PENDING_UNHEALTHY_SIZE = 100;
const ABSTRACT_BOOK_PENDING_UNHEALTHY_AGE_MS = 60 * 60 * 1000; // 1h

export interface AbstractBookQueueHealth {
  pendingCount: number;
  duePendingCount: number;
  runningCount: number;
  staleRunningCount: number;
  failedCount: number;
  oldestPendingAgeMs: number;
  isHealthy: boolean;
}

export async function getAbstractBookQueueHealth(): Promise<AbstractBookQueueHealth> {
  const now = new Date();
  const db = getDb();
  const countWhere = async (where: SQL): Promise<number> => {
    const [row] = await db
      .select({ n: count() })
      .from(abstractBookJobs)
      .where(where);
    return row?.n ?? 0;
  };

  const [
    pendingCount,
    duePendingCount,
    runningCount,
    staleRunningCount,
    failedCount,
    oldestPending,
  ] = await Promise.all([
    countWhere(eq(abstractBookJobs.status, "PENDING")),
    countWhere(
      and(
        eq(abstractBookJobs.status, "PENDING"),
        or(
          isNull(abstractBookJobs.nextAttemptAt),
          lte(abstractBookJobs.nextAttemptAt, now),
        ),
      )!,
    ),
    countWhere(eq(abstractBookJobs.status, "RUNNING")),
    countWhere(
      and(
        eq(abstractBookJobs.status, "RUNNING"),
        or(
          isNull(abstractBookJobs.lockedUntil),
          lt(abstractBookJobs.lockedUntil, now),
        ),
      )!,
    ),
    countWhere(eq(abstractBookJobs.status, "FAILED")),
    // Age computed in SQL (now() - MIN(col)) — never JS-parse a naive timestamp
    // read from the DB, which skews by the host offset on non-UTC hosts.
    // Mirrors getOutboxHealth. MIN over an empty set → NULL → 0.
    db
      .select({
        age: sql<number>`coalesce(extract(epoch from (now() - min(${abstractBookJobs.createdAt}))) * 1000, 0)::float8`,
      })
      .from(abstractBookJobs)
      .where(eq(abstractBookJobs.status, "PENDING")),
  ]);

  const oldestPendingAgeMs = Math.round(Number(oldestPending[0]?.age ?? 0));

  const isHealthy =
    staleRunningCount === 0 &&
    pendingCount < ABSTRACT_BOOK_PENDING_UNHEALTHY_SIZE &&
    oldestPendingAgeMs < ABSTRACT_BOOK_PENDING_UNHEALTHY_AGE_MS;

  return {
    pendingCount,
    duePendingCount,
    runningCount,
    staleRunningCount,
    failedCount,
    oldestPendingAgeMs,
    isHealthy,
  };
}
