import { and, eq, sql } from "drizzle-orm";
import { newId } from "@app/shared";
import { pgUniqueViolation, withTxn } from "../txn";
import { abstracts } from "../schema/abstracts";
import { emailLogs, emailTemplates } from "../schema/email";
import { registrations } from "../schema/registrations";
import type { EmailLogRow } from "./email";
import { readEmailContextSnapshot } from "./stored-json";

/**
 * Keys of a plain-text fallback template stashed in context_snapshot when an
 * abstract email has no admin template (the email queue renders it like a
 * template; same keys as FALLBACK_*_KEY in @app/integrations email/queue.ts).
 */
const EMAIL_FALLBACK_SUBJECT_KEY = "_fallbackSubject";
const EMAIL_FALLBACK_BODY_KEY = "_fallbackPlainBody";

export type ResendEmailLogResult =
  | { ok: true; log: EmailLogRow }
  | {
      ok: false;
      reason:
        /** No such log in this event. */
        | "not_found"
        /** Only an UNCERTAIN email is resent by hand. */
        | "not_uncertain"
        /** The queue cannot render it again (a one-off send, or a networking email). */
        | "not_resendable"
        /** An active email already covers it: this log's resend, or another email for the same trigger. */
        | "already_active";
    };

/** The dedupe key of the one active resend of a log. */
export function emailLogResendKey(sourceId: string): string {
  return `resend:${sourceId}`;
}

function queueCanRender(log: { templateId: string | null; contextSnapshot: unknown }): boolean {
  if (log.templateId) return true;
  const snapshot = log.contextSnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
  const values = snapshot as Record<string, unknown>;
  return typeof values[EMAIL_FALLBACK_SUBJECT_KEY] === "string" && typeof values[EMAIL_FALLBACK_BODY_KEY] === "string";
}

/**
 * An admin's explicit resend of an UNCERTAIN email (3.6): queue a new email
 * log with the same template, recipient and context, for the worker to render
 * and send. The UNCERTAIN log stays (it may have been delivered; a webhook can
 * still move it forward) and its error message points at the new log.
 *
 * A new log gets a new provider idempotency key, so the email really goes out
 * again. Its dedupe key `resend:<source id>` makes a concurrent second resend
 * of the same log fail while the first is active.
 */
export async function resendUncertainEmailLog(eventId: string, sourceId: string): Promise<ResendEmailLogResult> {
  try {
    return await withTxn(async (tx) => {
      const [row] = await tx
        .select({
          log: emailLogs,
          eventId: sql<string | null>`COALESCE(${registrations.eventId}, ${emailTemplates.eventId}, ${abstracts.eventId})`,
        })
        .from(emailLogs)
        .leftJoin(registrations, eq(registrations.id, emailLogs.registrationId))
        .leftJoin(emailTemplates, eq(emailTemplates.id, emailLogs.templateId))
        .leftJoin(abstracts, eq(abstracts.id, emailLogs.abstractId))
        .where(eq(emailLogs.id, sourceId))
        .limit(1);
      if (!row || row.eventId !== eventId) return { ok: false, reason: "not_found" } as const;
      const source = row.log;
      if (source.status !== "UNCERTAIN") return { ok: false, reason: "not_uncertain" } as const;
      const snapshot = readEmailContextSnapshot(source.contextSnapshot, source.id);
      if (snapshot?.dispatchOwner === "networking" || !queueCanRender(source)) {
        return { ok: false, reason: "not_resendable" } as const;
      }

      const id = newId();
      const noted = await tx
        .update(emailLogs)
        .set({ errorMessage: `Resent by an admin as email log ${id}` })
        .where(and(eq(emailLogs.id, sourceId), eq(emailLogs.status, "UNCERTAIN")))
        .returning({ id: emailLogs.id });
      // A webhook moved it forward in the meantime.
      if (noted.length === 0) return { ok: false, reason: "not_uncertain" } as const;

      const [log] = await tx
        .insert(emailLogs)
        .values({
          id,
          trigger: source.trigger,
          templateId: source.templateId,
          registrationId: source.registrationId,
          abstractId: source.abstractId,
          abstractTrigger: source.abstractTrigger,
          recipientEmail: source.recipientEmail,
          recipientName: source.recipientName,
          subject: "",
          status: "QUEUED",
          maxRetries: source.maxRetries,
          contextSnapshot: source.contextSnapshot,
          dedupeKey: emailLogResendKey(sourceId),
        })
        .returning();
      return { ok: true, log: log! } as const;
    });
  } catch (err) {
    // The resend key, or a per-trigger dedupe index: an active email already covers it.
    if (pgUniqueViolation(err)) return { ok: false, reason: "already_active" };
    throw err;
  }
}
