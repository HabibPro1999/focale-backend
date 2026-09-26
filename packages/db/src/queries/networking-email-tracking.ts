import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { rowsOf } from "../helpers";
import { getDb, type DbExecutor } from "../client";
import { withTxnRetry } from "../txn";
import { emailLogs } from "../schema/email";
import { networkingDeliveries } from "../schema/networking";
import type { NetworkingDeliveryRow } from "./networking-delivery";

// Lock the delivery while checking ownership and writing its email log.
async function ownsDelivery(db: DbExecutor, row: NetworkingDeliveryRow) {
  return rowsOf(await db.execute(sql`SELECT id FROM networking_deliveries
      WHERE id=${row.id} AND status='PROCESSING' AND locked_until=${row.lockedUntil?.toISOString()}::timestamp
        AND locked_until>now() FOR UPDATE`)).length > 0;
}

/** Statuses meaning the provider took this email (a webhook may already have moved it on). */
const PROVIDER_TOOK_IT = ["SENT", "DELIVERED", "OPENED", "CLICKED", "BOUNCED", "DROPPED"] as const;

/** Why an email is UNCERTAIN: its provider call has no recorded answer. */
export const NETWORKING_EMAIL_UNCERTAIN_MESSAGE =
  "The email provider was called but its answer was never recorded; not resent automatically";

export interface NetworkingEmailLogStart {
  leaseLost?: boolean;
  /** The provider already took this email: never send it again. */
  alreadySent: boolean;
  /**
   * An earlier attempt called the provider and its outcome is unknown (the
   * log is UNCERTAIN): never sent again automatically.
   */
  uncertain?: boolean;
}

/**
 * These rows belong exclusively to the networking worker, never to the
 * generic email queue (which neither claims nor recovers them).
 *
 * 3.6 / 4.2: a log whose provider-attempt marker is still set was being sent
 * when its worker lost the delivery lease (crash or timeout). Resend
 * deduplicates on the log id (its idempotency key), so the send goes ahead
 * under the same key; for any other provider the log becomes UNCERTAIN and
 * the email is not sent again.
 */
export async function beginNetworkingEmailLog(
  row: NetworkingDeliveryRow,
  input: {
    registrationId: string;
    recipientEmail: string;
    recipientName: string;
    subject: string;
  },
): Promise<NetworkingEmailLogStart> {
  return withTxnRetry(() => getDb().transaction(async (db) => {
    if (!(await ownsDelivery(db, row))) return { alreadySent: false, leaseLost: true };
    await db
      .insert(emailLogs)
      .values({
        id: row.id,
        ...input,
        status: "SENDING",
        maxRetries: 4,
        attemptCount: 1,
        lastAttemptAt: new Date(),
        lockedBy: `networking:${row.id}`,
        lockedAt: new Date(),
        lockedUntil: row.lockedUntil,
        dedupeKey: `networking:${row.id}`,
        contextSnapshot: {
          dispatchOwner: "networking",
          eventId: row.eventId,
          profileId: row.profileId,
          networkingType: row.type,
          deliveryId: row.id,
        },
      })
      .onConflictDoNothing({ target: emailLogs.id });
    const [existing] = await db
      .select()
      .from(emailLogs)
      .where(eq(emailLogs.id, row.id));
    if (!existing) throw new Error("Email tracking log could not be created");
    if ((PROVIDER_TOOK_IT as readonly string[]).includes(existing.status))
      return { alreadySent: true };
    if (existing.status === "UNCERTAIN") return { alreadySent: false, uncertain: true };
    if (existing.status === "SENDING" && existing.providerAttemptedAt && existing.provider !== "resend") {
      await db
        .update(emailLogs)
        .set({
          status: "UNCERTAIN",
          errorMessage: NETWORKING_EMAIL_UNCERTAIN_MESSAGE,
          lockedBy: null,
          lockedAt: null,
          lockedUntil: null,
          updatedAt: new Date(),
        })
        .where(and(eq(emailLogs.id, row.id), eq(emailLogs.status, "SENDING")));
      return { alreadySent: false, uncertain: true };
    }
    await db
      .update(emailLogs)
      .set({
        subject: input.subject,
        recipientEmail: input.recipientEmail,
        recipientName: input.recipientName,
        status: "SENDING",
        attemptCount: row.attempts,
        lastAttemptAt: new Date(),
        lockedAt: new Date(),
        lockedUntil: row.lockedUntil,
        lockedBy: `networking:${row.id}`,
        errorMessage: null,
        providerAttemptedAt: null,
        provider: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(emailLogs.id, row.id),
          inArray(emailLogs.status, ["SENDING", "FAILED", "SKIPPED"]),
        ),
      );
    return { alreadySent: false };
  }));
}

/**
 * The provider-attempt marker (3.6), written right before the provider call
 * under the delivery lock, together with a lease renewal. False (and nothing
 * sent) when the lease was lost or the log is no longer SENDING.
 */
export async function markNetworkingEmailAttempt(
  row: NetworkingDeliveryRow,
  provider: string,
): Promise<boolean> {
  const lockedUntil = new Date(Date.now() + 5 * 60_000);
  const marked = await withTxnRetry(() => getDb().transaction(async (db) => {
    if (!(await ownsDelivery(db, row))) return false;
    const updated = await db
      .update(emailLogs)
      .set({ providerAttemptedAt: new Date(), provider, lockedUntil, updatedAt: new Date() })
      .where(and(eq(emailLogs.id, row.id), eq(emailLogs.status, "SENDING")))
      .returning({ id: emailLogs.id });
    if (!updated.length) return false;
    await db
      .update(networkingDeliveries)
      .set({ lockedUntil, updatedAt: new Date() })
      .where(eq(networkingDeliveries.id, row.id));
    return true;
  }));
  if (marked) row.lockedUntil = lockedUntil;
  return marked;
}

/**
 * How one networking email attempt ended:
 * - `sent`: the provider took it (recorded even after the lease was lost).
 * - `failed`: nothing was sent (a rejection, or an error before the call), or
 *   an ambiguous Resend call that is retried under the same idempotency key.
 * - `deferred`: the provider refused it for its rate limit (429), or the
 *   worker stopped before sending it; retried later without counting as a
 *   failure.
 * - `skipped`: no longer eligible. A log whose marker is still set (an earlier
 *   attempt called the provider) becomes UNCERTAIN instead.
 * - `uncertain`: the provider may have sent it; never sent again automatically.
 */
export type NetworkingEmailOutcome = "sent" | "failed" | "deferred" | "skipped" | "uncertain";

export async function finishNetworkingEmailLog(
  row: NetworkingDeliveryRow,
  outcome: NetworkingEmailOutcome,
  detail?: string,
): Promise<void> {
  return withTxnRetry(() => getDb().transaction(async (db) => {
    // A provider-confirmed send is a fact even after the lease was lost; other outcomes stay fenced.
    if (outcome !== "sent" && !(await ownsDelivery(db, row))) return;
    const unlocked = { lockedBy: null, lockedAt: null, lockedUntil: null, updatedAt: new Date() };
    if (outcome === "sent") {
      // Fast webhooks can arrive before the provider response: never downgrade their delivery/open/click state.
      await db
        .update(emailLogs)
        .set({ providerMessageId: detail, sentAt: new Date(), errorMessage: null, ...unlocked })
        .where(eq(emailLogs.id, row.id));
      await db
        .update(emailLogs)
        .set({ status: "SENT", failedAt: null })
        .where(and(eq(emailLogs.id, row.id), inArray(emailLogs.status, ["SENDING", "FAILED", "SKIPPED", "UNCERTAIN"])));
    } else if (outcome === "uncertain") {
      await db
        .update(emailLogs)
        .set({ status: "UNCERTAIN", errorMessage: detail ?? NETWORKING_EMAIL_UNCERTAIN_MESSAGE, failedAt: null, ...unlocked })
        .where(and(eq(emailLogs.id, row.id), eq(emailLogs.status, "SENDING")));
    } else if (outcome === "skipped") {
      await db
        .update(emailLogs)
        .set({ status: "UNCERTAIN", errorMessage: NETWORKING_EMAIL_UNCERTAIN_MESSAGE, failedAt: null, ...unlocked })
        .where(and(eq(emailLogs.id, row.id), eq(emailLogs.status, "SENDING"), isNotNull(emailLogs.providerAttemptedAt)));
      await db
        .update(emailLogs)
        .set({ status: "SKIPPED", errorMessage: "Networking delivery no longer eligible", failedAt: null, ...unlocked })
        .where(and(eq(emailLogs.id, row.id), inArray(emailLogs.status, ["SENDING", "FAILED"])));
    } else {
      // failed / deferred: nothing reached the provider, or Resend retries
      // under the same key, so the marker is cleared for the next attempt.
      const failed = outcome === "failed";
      const exhausted = failed && row.attempts >= 5;
      await db
        .update(emailLogs)
        .set({
          status: exhausted ? "FAILED" : "SENDING",
          errorMessage: detail ?? (failed
            ? "Networking email delivery failed"
            : "Networking email deferred by the provider rate limit"),
          retryCount: sql`${emailLogs.retryCount}+${failed ? 1 : 0}`,
          failedAt: exhausted ? new Date() : null,
          providerAttemptedAt: null,
          provider: null,
          ...unlocked,
        })
        .where(
          and(
            eq(emailLogs.id, row.id),
            inArray(emailLogs.status, ["SENDING", "FAILED"]),
          ),
        );
    }
  }));
}

/**
 * Maintenance: a networking email log left SENDING after its delivery ended
 * (exhausted, skipped, sent through another channel, or deleted) is settled,
 * as UNCERTAIN when its provider call has no recorded answer, else FAILED.
 * Only logs whose lease expired; a delivery that will be claimed again keeps
 * its log.
 */
export async function settleOrphanedNetworkingEmailLogs(
  eventId: string | undefined,
  db: DbExecutor,
): Promise<number> {
  const result = rowsOf<{ id: string }>(await db.execute(sql`
    UPDATE email_logs l SET
      status = CASE WHEN l.provider_attempted_at IS NOT NULL THEN 'UNCERTAIN'::"EmailStatus" ELSE 'FAILED'::"EmailStatus" END,
      error_message = CASE WHEN l.provider_attempted_at IS NOT NULL THEN ${NETWORKING_EMAIL_UNCERTAIN_MESSAGE}
        ELSE 'Networking delivery ended before this email was sent' END,
      failed_at = CASE WHEN l.provider_attempted_at IS NOT NULL THEN NULL ELSE now() END,
      locked_by = NULL, locked_at = NULL, locked_until = NULL, updated_at = now()
    WHERE l.status = 'SENDING' AND (l.locked_until IS NULL OR l.locked_until < now())
      AND (l.context_snapshot ->> 'dispatchOwner') = 'networking'
      ${eventId ? sql`AND (l.context_snapshot ->> 'eventId') = ${eventId}` : sql``}
      AND NOT EXISTS (SELECT 1 FROM networking_deliveries d WHERE d.id = l.id
        AND (d.status IN ('PENDING', 'PROCESSING') OR (d.status = 'FAILED' AND d.attempts < 5)))
    RETURNING l.id`));
  return result.length;
}
