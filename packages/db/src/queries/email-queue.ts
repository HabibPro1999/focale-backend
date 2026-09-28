import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { StoredEmailContextSnapshot } from "@app/contracts";
import { getDb, type DbExecutor } from "../client";
import { rowCountOf, STANDARD_RETRY_DELAYS_MS, standardRetryDelayMs } from "../helpers";
import { DB_NOW, backoffInterval, createLeaseQueue, intervalMs } from "../lease-queue";
import { emailLogs, emailTemplates } from "../schema/email";
import {
  getRegistrationsForEmailContextByIds,
  type RegistrationEmailContext,
} from "./email-context";
import type { EmailLogInsert, EmailLogRow } from "./email-logs";
import type { EmailTemplateRow } from "./email-templates";

type AutomaticTrigger = NonNullable<EmailTemplateRow["trigger"]>;
type EmailStatus = EmailLogRow["status"];

// ============================================================================
// EMAIL QUEUE — a lease queue (packages/db/src/lease-queue).
//
// Concurrency safety here is lease-based, NOT transaction-based: the claim uses
// FOR UPDATE SKIP LOCKED, records lockedBy/lockedUntil, and EVERY subsequent
// write re-checks that ownership (status=SENDING AND locked_by=workerId).
// Deliberately NOT withTxnRetry/serializable — the semantics are lease expiry +
// ownership, not conflict retry. Lease times come from the database clock;
// the worker's LeaseRecoveryJob recovers expired leases.
// ============================================================================

/** Worker lease (10 min); runLeased's heartbeat renews it while a batch runs. */
export const EMAIL_LEASE_MS = 10 * 60 * 1000;
const EMAIL_QUEUE_UNHEALTHY_AGE_MS = 30 * 60 * 1000;
const EMAIL_QUEUE_UNHEALTHY_SIZE = 1000;

// Rows the networking dispatcher owns (it claims and recovers them itself).
const NETWORKING_OWNED = sql`"context_snapshot"->>'dispatchOwner' IS NOT DISTINCT FROM 'networking'`;

/**
 * email_logs as a lease queue. Due QUEUED rows are claimable (FIFO by
 * queued_at) while attempt_count <= max_retries (max_retries + 1 sends in
 * all); SENDING is the lease. attempt_count counts claims; retry_count counts
 * failures and expired leases, and decides dead-lettering on recovery. A
 * released row goes back to QUEUED, due now. An expired lease is requeued with
 * the retry backoff, or FAILED once retry_count reaches max_retries.
 *
 * 3.6: a claim clears the provider-attempt marker, and beginProviderAttempt
 * sets it right before the provider call. A marked row may already have been
 * sent, so release leaves it leased, and recovery parks an expired one as
 * UNCERTAIN, unless its provider deduplicates on the log id (Resend): that one
 * is requeued like any expired lease, and parked only once its retries are
 * used up.
 * Networking-dispatched rows are never claimed or recovered here.
 */
export const emailQueue = createLeaseQueue({
  name: "email",
  table: "email_logs",
  leasedStatus: "SENDING",
  leaseMs: EMAIL_LEASE_MS,
  claimable: sql`"status" = 'QUEUED'
    AND "context_snapshot"->>'dispatchOwner' IS DISTINCT FROM 'networking'
    AND ("next_attempt_at" IS NULL OR "next_attempt_at" <= ${DB_NOW})
    AND "attempt_count" <= "max_retries"`,
  order: sql`"queued_at" ASC`,
  claimSet: sql`"error_message" = NULL, "provider_attempted_at" = NULL, "provider" = NULL`,
  releaseSet: sql`"status" = 'QUEUED', "next_attempt_at" = NULL`,
  releasable: sql`"provider_attempted_at" IS NULL`,
  recovery: {
    uncertain: {
      // Resend is the provider keyed on the log id (its idempotency key).
      where: sql`"provider_attempted_at" IS NOT NULL
        AND ("provider" IS DISTINCT FROM 'resend' OR "retry_count" >= "max_retries")`,
      set: sql`"status" = 'UNCERTAIN', "next_attempt_at" = NULL,
        "error_message" = 'The email provider was called but its answer was never recorded (lease expired); not resent automatically'`,
    },
    exhausted: sql`"retry_count" >= "max_retries"`,
    retrySet: sql`"status" = 'QUEUED', "retry_count" = "retry_count" + 1,
      "next_attempt_at" = ${DB_NOW} + ${backoffInterval(sql`("retry_count" + 1)`, STANDARD_RETRY_DELAYS_MS)},
      "error_message" = COALESCE("error_message", 'Email send lease expired; requeued for retry')`,
    deadSet: sql`"status" = 'FAILED', "failed_at" = ${DB_NOW}, "next_attempt_at" = NULL,
      "retry_count" = "retry_count" + 1,
      "error_message" = COALESCE("error_message", 'Email send lease expired and retry limit was exhausted')`,
    exclude: NETWORKING_OWNED,
  },
});

/**
 * Statuses that count as "an email already in flight" for the dedupe
 * pre-checks. UNCERTAIN counts (it may have been sent; only an admin resends
 * it), although the partial unique indexes behind them do not list it.
 */
const ACTIVE_EMAIL_STATUSES = [
  "QUEUED",
  "SENDING",
  "SENT",
  "DELIVERED",
  "UNCERTAIN",
] as const satisfies readonly EmailStatus[];

// ----------------------------------------------------------------------------
// Dedupe pre-checks (SELECT-then-INSERT; the partial unique indexes in
// createEmailLog are the race backstop).
// ----------------------------------------------------------------------------

/** True if an active email already exists for this registration + trigger. */
export async function hasActiveEmailLogForRegistrationTrigger(
  registrationId: string,
  trigger: AutomaticTrigger,
  exec: DbExecutor = getDb(),
): Promise<boolean> {
  const [row] = await exec
    .select({ id: emailLogs.id })
    .from(emailLogs)
    .where(
      and(
        eq(emailLogs.registrationId, registrationId),
        eq(emailLogs.trigger, trigger),
        inArray(emailLogs.status, [...ACTIVE_EMAIL_STATUSES]),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * True if an active sponsorship email already exists for this trigger+template+
 * recipient (+registration when provided). Mirrors legacy queueSponsorshipEmail.
 */
export async function hasActiveSponsorshipEmailLog(
  args: {
    trigger: AutomaticTrigger;
    templateId: string;
    recipientEmail: string;
    registrationId?: string;
  },
  exec: DbExecutor = getDb(),
): Promise<boolean> {
  const conds: SQL[] = [
    eq(emailLogs.trigger, args.trigger),
    eq(emailLogs.templateId, args.templateId),
    eq(emailLogs.recipientEmail, args.recipientEmail),
    inArray(emailLogs.status, [...ACTIVE_EMAIL_STATUSES]),
  ];
  if (args.registrationId) {
    conds.push(eq(emailLogs.registrationId, args.registrationId));
  }
  const [row] = await exec
    .select({ id: emailLogs.id })
    .from(emailLogs)
    .where(and(...conds))
    .limit(1);
  return !!row;
}

// ----------------------------------------------------------------------------
// Claimed rows + relation re-fetch (the claim is emailQueue.claim)
// ----------------------------------------------------------------------------

/** A claimed EmailLog joined with the relations the send pipeline needs. */
export interface ClaimedEmailLog {
  id: string;
  trigger: AutomaticTrigger | null;
  templateId: string | null;
  registrationId: string | null;
  /** H2: set instead of registrationId for abstract-linked certificate emails. */
  abstractId: string | null;
  recipientEmail: string;
  recipientName: string | null;
  /** As stored: the send path checks it (readEmailContextSnapshot) per row. */
  contextSnapshot: StoredEmailContextSnapshot;
  attemptCount: number;
  maxRetries: number;
  template: EmailTemplateRow | null;
  registration: RegistrationEmailContext | null;
}

/**
 * Re-fetch claimed rows filtered again by status=SENDING + lockedBy (defends
 * against a lease stolen between the claim and this read), with template +
 * registration relations. FIFO by queued_at.
 */
export async function getClaimedEmailLogsForProcessing(
  workerId: string,
  ids: string[],
  exec: DbExecutor = getDb(),
): Promise<ClaimedEmailLog[]> {
  if (ids.length === 0) return [];
  const logs = await exec
    .select()
    .from(emailLogs)
    .where(
      and(
        inArray(emailLogs.id, ids),
        eq(emailLogs.status, "SENDING"),
        eq(emailLogs.lockedBy, workerId),
      ),
    )
    .orderBy(asc(emailLogs.queuedAt));
  if (logs.length === 0) return [];

  const templateIds = [
    ...new Set(
      logs.map((l) => l.templateId).filter((x): x is string => !!x),
    ),
  ];
  const registrationIds = [
    ...new Set(
      logs.map((l) => l.registrationId).filter((x): x is string => !!x),
    ),
  ];

  const templateRows = templateIds.length
    ? await exec
        .select()
        .from(emailTemplates)
        .where(inArray(emailTemplates.id, templateIds))
    : [];
  const templateMap = new Map(templateRows.map((t) => [t.id, t]));

  const regs = await getRegistrationsForEmailContextByIds(registrationIds, exec);
  const regMap = new Map(regs.map((r) => [r.id, r]));

  return logs.map((l) => ({
    id: l.id,
    trigger: l.trigger,
    templateId: l.templateId,
    registrationId: l.registrationId,
    abstractId: l.abstractId,
    recipientEmail: l.recipientEmail,
    recipientName: l.recipientName,
    contextSnapshot: l.contextSnapshot,
    attemptCount: l.attemptCount,
    maxRetries: l.maxRetries,
    template: l.templateId ? templateMap.get(l.templateId) ?? null : null,
    registration: l.registrationId ? regMap.get(l.registrationId) ?? null : null,
  }));
}

// ----------------------------------------------------------------------------
// Lease-guarded writes — each returns false (not throw) when the row is no
// longer owned by `workerId`, which callers map to a non-counted "lease-lost"
// outcome. Terminal writes go through emailQueue (they clear the lease).
// ----------------------------------------------------------------------------

/** Write the resolved subject only while this worker still owns the row. */
export async function writeResolvedSubjectIfLeaseHeld(
  id: string,
  workerId: string,
  subject: string,
): Promise<boolean> {
  const res = await getDb().execute(sql`
    UPDATE "email_logs"
    SET "subject" = ${subject}, "updated_at" = ${DB_NOW}
    WHERE "id" = ${id} AND "status" = 'SENDING' AND "locked_by" = ${workerId}
  `);
  return rowCountOf(res) > 0;
}

/**
 * The provider-attempt marker (3.6): in the lease-guarded UPDATE right before
 * the provider call, stamp provider_attempted_at and the provider, and extend
 * the lease (it doubles as the ownership confirm). False when the row is no
 * longer owned: the provider must not be called. From here on the row is
 * never released or requeued blind; see emailQueue.
 */
export async function beginProviderAttempt(
  id: string,
  workerId: string,
  provider: string,
  leaseMs: number = EMAIL_LEASE_MS,
): Promise<boolean> {
  const res = await getDb().execute(sql`
    UPDATE "email_logs"
    SET "provider_attempted_at" = ${DB_NOW}, "provider" = ${provider},
        "locked_until" = ${DB_NOW} + ${intervalMs(leaseMs)}, "updated_at" = ${DB_NOW}
    WHERE "id" = ${id} AND "status" = 'SENDING' AND "locked_by" = ${workerId}
    RETURNING "id"
  `);
  return rowCountOf(res) > 0;
}

/** Lease of a send-now row: covers the provider call (15 s timeout) and the outcome write. */
export const SEND_NOW_LEASE_MS = 2 * 60 * 1000;

/** What a send-now email records besides its lease (no automatic trigger, no dedupe key). */
export type SendNowEmailLogValues = Pick<
  EmailLogInsert,
  | "recipientEmail"
  | "recipientName"
  | "subject"
  | "templateId"
  | "registrationId"
  | "abstractId"
  | "abstractTrigger"
  | "contextSnapshot"
>;

/**
 * The email_logs row of an email sent right away (3.6b, sendEmailNow), written
 * before the provider call. It is born leased by `workerId` (SENDING, lease
 * `leaseMs`) with the provider-attempt marker set and `max_retries` 0, so the
 * settle writes below apply to it, and if the process dies mid-send, lease
 * recovery parks it as UNCERTAIN, for either provider: nothing can render a
 * send-now email again, so it is never requeued.
 */
export async function createSendNowEmailLog(
  values: SendNowEmailLogValues,
  workerId: string,
  provider: string,
  leaseMs: number = SEND_NOW_LEASE_MS,
): Promise<EmailLogRow> {
  const [log] = await getDb()
    .insert(emailLogs)
    .values({
      ...values,
      status: "SENDING",
      maxRetries: 0,
      attemptCount: 1,
      lastAttemptAt: DB_NOW,
      lockedAt: DB_NOW,
      lockedBy: workerId,
      lockedUntil: sql`${DB_NOW} + ${intervalMs(leaseMs)}`,
      providerAttemptedAt: DB_NOW,
      provider,
    })
    .returning();
  return log;
}

/**
 * The provider may have taken the email but never confirmed it (an ambiguous
 * outcome that must not be retried): park it as UNCERTAIN. A webhook moves it
 * forward; an admin can resend it.
 */
export async function markEmailUncertain(
  id: string,
  workerId: string,
  errorMessage: string,
): Promise<boolean> {
  return emailQueue.complete(
    workerId,
    id,
    sql`"status" = 'UNCERTAIN', "error_message" = ${errorMessage}, "next_attempt_at" = NULL`,
  );
}

export async function markEmailSent(
  id: string,
  workerId: string,
  messageId: string | undefined,
): Promise<boolean> {
  return emailQueue.complete(
    workerId,
    id,
    sql`"status" = 'SENT', "sendgrid_message_id" = ${messageId ?? null},
      "sent_at" = ${DB_NOW}, "error_message" = NULL, "next_attempt_at" = NULL`,
  );
}

/**
 * The status a failed send leaves (markEmailFailed): QUEUED, to be retried,
 * while the attemptCount of this claim (already incremented) has not exceeded
 * maxRetries; FAILED after. Lease recovery gates on retry_count instead.
 */
export function emailFailureStatus(
  attemptCount: number,
  maxRetries: number,
): "QUEUED" | "FAILED" {
  return attemptCount <= maxRetries ? "QUEUED" : "FAILED";
}

/**
 * Retry → QUEUED with backoff nextAttemptAt; else → FAILED (see
 * emailFailureStatus). Lease cleared either way.
 */
export async function markEmailFailed(
  id: string,
  workerId: string,
  errorMessage: string,
  attemptCount: number,
  maxRetries: number,
): Promise<boolean> {
  const set =
    emailFailureStatus(attemptCount, maxRetries) === "QUEUED"
      ? sql`"status" = 'QUEUED', "error_message" = ${errorMessage},
          "retry_count" = "retry_count" + 1, "failed_at" = NULL,
          "next_attempt_at" = ${DB_NOW} + ${intervalMs(standardRetryDelayMs(Math.max(1, attemptCount)))}`
      : sql`"status" = 'FAILED', "error_message" = ${errorMessage},
          "retry_count" = "retry_count" + 1, "failed_at" = ${DB_NOW}, "next_attempt_at" = NULL`;
  return emailQueue.fail(workerId, id, set);
}

export async function markEmailSkipped(
  id: string,
  workerId: string,
  reason: string,
): Promise<boolean> {
  return emailQueue.complete(
    workerId,
    id,
    sql`"status" = 'SKIPPED', "error_message" = ${reason}, "next_attempt_at" = NULL`,
  );
}

// ----------------------------------------------------------------------------
// Health + stats
// ----------------------------------------------------------------------------

export interface EmailQueueHealth {
  queueSize: number;
  dueQueuedCount: number;
  sendingCount: number;
  staleSendingCount: number;
  failedCount: number;
  deadLetterCount: number;
  /** Emails parked as UNCERTAIN (may have been sent; an admin decides). */
  uncertainCount: number;
  oldestQueuedAgeMs: number;
  oldestInFlightAgeMs: number;
  recentFailures24h: number;
  isHealthy: boolean;
}

export async function getEmailQueueHealth(): Promise<EmailQueueHealth> {
  const now = new Date();
  const db = getDb();
  const countWhere = async (where: SQL): Promise<number> => {
    const [row] = await db
      .select({ n: count() })
      .from(emailLogs)
      .where(where);
    return row?.n ?? 0;
  };

  const [
    queueSize,
    dueQueuedCount,
    sendingCount,
    staleSendingCount,
    failedCount,
    uncertainCount,
    recentFailures,
    oldestQueued,
    oldestInFlight,
  ] = await Promise.all([
    countWhere(eq(emailLogs.status, "QUEUED")),
    countWhere(
      and(
        eq(emailLogs.status, "QUEUED"),
        or(isNull(emailLogs.nextAttemptAt), lte(emailLogs.nextAttemptAt, now)),
      )!,
    ),
    countWhere(eq(emailLogs.status, "SENDING")),
    countWhere(
      and(
        eq(emailLogs.status, "SENDING"),
        or(isNull(emailLogs.lockedUntil), lt(emailLogs.lockedUntil, now)),
      )!,
    ),
    countWhere(eq(emailLogs.status, "FAILED")),
    countWhere(eq(emailLogs.status, "UNCERTAIN")),
    countWhere(
      and(
        eq(emailLogs.status, "FAILED"),
        gte(emailLogs.updatedAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
      )!,
    ),
    // Ages computed in SQL (now() - MIN(col)) — never JS-parse a naive
    // timestamp read from the DB, which skews by the host offset on non-UTC
    // hosts. Mirrors getOutboxHealth. MIN over an empty set → NULL → 0.
    db
      .select({
        age: sql<number>`coalesce(extract(epoch from (now() - min(${emailLogs.queuedAt}))) * 1000, 0)::float8`,
      })
      .from(emailLogs)
      .where(eq(emailLogs.status, "QUEUED")),
    db
      .select({
        age: sql<number>`coalesce(extract(epoch from (now() - min(coalesce(${emailLogs.lockedAt}, ${emailLogs.updatedAt})))) * 1000, 0)::float8`,
      })
      .from(emailLogs)
      .where(eq(emailLogs.status, "SENDING")),
  ]);

  const oldestQueuedAgeMs = Math.round(Number(oldestQueued[0]?.age ?? 0));
  const oldestInFlightAgeMs = Math.round(Number(oldestInFlight[0]?.age ?? 0));

  const isHealthy =
    staleSendingCount === 0 &&
    queueSize < EMAIL_QUEUE_UNHEALTHY_SIZE &&
    oldestQueuedAgeMs < EMAIL_QUEUE_UNHEALTHY_AGE_MS;

  return {
    queueSize,
    dueQueuedCount,
    sendingCount,
    staleSendingCount,
    failedCount,
    deadLetterCount: failedCount,
    uncertainCount,
    oldestQueuedAgeMs,
    oldestInFlightAgeMs,
    recentFailures24h: recentFailures,
    isHealthy,
  };
}
