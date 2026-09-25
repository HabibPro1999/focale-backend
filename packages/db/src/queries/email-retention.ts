import { sql, type SQL } from "drizzle-orm";
import { getDb } from "../client";
import { rowCountOf } from "../helpers";
import { DB_NOW, intervalMs } from "../lease-queue";

const DAY_MS = 24 * 60 * 60 * 1000;

/** email_logs context snapshot retention (worker RetentionJob, hourly). */
export const EMAIL_SNAPSHOT_RETENTION = {
  /** A finished email keeps its context snapshot for 90 days after it was queued. */
  maxAgeMs: 90 * DAY_MS,
  /**
   * After a process's first complete pass, later passes only look this far
   * past the age limit (the rows that aged out since), not at every old row.
   */
  lookbackMs: 7 * DAY_MS,
  /** Rows per statement: short statements, short locks. */
  batchSize: 1_000,
} as const;

/**
 * Statuses in which nothing reads the snapshot again: sent (webhooks only move
 * the status), refused, failed for good or skipped. QUEUED/SENDING rows still
 * render from it, and an UNCERTAIN one may be resent from it.
 */
const FINISHED = sql.raw(
  `'SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'BOUNCED', 'DROPPED', 'FAILED', 'SKIPPED'`,
);

/**
 * What a finished email keeps: a certificate email's
 * `_certificateTemplateIds`, which the certificate send reads to skip
 * certificates already sent; NULL for everything else.
 */
const RETAINED = sql`(CASE
    WHEN "trigger" = 'CERTIFICATE_SENT' AND ("context_snapshot" -> '_certificateTemplateIds') IS NOT NULL
    THEN jsonb_build_object('_certificateTemplateIds', "context_snapshot" -> '_certificateTemplateIds')
  END)`;

/**
 * Finished emails queued before the age limit (and, with a lookback, not
 * before the limit plus the lookback) whose snapshot is not in its retained
 * form yet. Rows the networking dispatcher owns are left alone: networking
 * retention owns them, and its purge and reports find them through their
 * snapshot's `eventId`.
 */
function clearable(maxAgeMs: number, lookbackMs: number | null): SQL {
  const since =
    lookbackMs === null
      ? sql``
      : sql`AND "queued_at" >= ${DB_NOW} - ${intervalMs(maxAgeMs + lookbackMs)}`;
  return sql`"status" IN (${FINISHED})
    AND "queued_at" < ${DB_NOW} - ${intervalMs(maxAgeMs)} ${since}
    AND "context_snapshot" IS NOT NULL
    AND "context_snapshot" IS DISTINCT FROM ${RETAINED}
    AND ("context_snapshot" ->> 'dispatchOwner') IS DISTINCT FROM 'networking'`;
}

// Pick up to `limit` rows (skipping rows another transaction holds), then
// rewrite those still matching: the predicate is repeated on the outer
// statement. updated_at is left alone: the email's delivery state is unchanged.
async function clearBatch(where: SQL, limit: number): Promise<number> {
  return rowCountOf(
    await getDb().execute(sql`
      UPDATE "email_logs" SET "context_snapshot" = ${RETAINED}
      WHERE "id" IN (
        SELECT "id" FROM "email_logs" WHERE ${where} LIMIT ${limit} FOR UPDATE SKIP LOCKED
      ) AND ${where}
    `),
  );
}

export interface EmailSnapshotRetentionOptions {
  /** Stop between batches once aborted (job timeout or shutdown). */
  signal?: AbortSignal;
  /** Whole table (true) or only the rows that aged out within the lookback. */
  fullPass: boolean;
  batchSize?: number;
  maxAgeMs?: number;
  lookbackMs?: number;
}

export interface EmailSnapshotRetentionResult {
  /** Rows whose snapshot was cleared (or cut down to the certificate ids). */
  cleared: number;
  /** False when the signal stopped the pass before the last batch. */
  complete: boolean;
}

/**
 * Clear the context snapshot of finished emails queued more than 90 days ago
 * (3.6b), in batches of `batchSize` rows (one autocommit statement each). A
 * certificate email keeps only `_certificateTemplateIds`; networking rows are
 * skipped. The snapshot holds the recipient's registration data for rendering
 * and is never shown after the send.
 */
export async function runEmailSnapshotRetention(
  options: EmailSnapshotRetentionOptions,
): Promise<EmailSnapshotRetentionResult> {
  const limit = options.batchSize ?? EMAIL_SNAPSHOT_RETENTION.batchSize;
  const where = clearable(
    options.maxAgeMs ?? EMAIL_SNAPSHOT_RETENTION.maxAgeMs,
    options.fullPass ? null : (options.lookbackMs ?? EMAIL_SNAPSHOT_RETENTION.lookbackMs),
  );
  let cleared = 0;
  while (!options.signal?.aborted) {
    const n = await clearBatch(where, limit);
    cleared += n;
    if (n < limit) return { cleared, complete: true };
  }
  return { cleared, complete: false };
}
