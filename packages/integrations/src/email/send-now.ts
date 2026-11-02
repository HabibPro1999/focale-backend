// =============================================================================
// SEND NOW (3.6b)
// The one path for emails sent during a request instead of through the queue
// (an admin's one-off email, committee invitations and password links). The
// email_logs row is written first, already leased and marked as a provider
// attempt; the provider is called once; its classified outcome settles the row
// (the same accepted / rejected / ambiguous classification as the queue).
//
// Nothing here is retried or requeued: nothing can render these emails again.
// An ambiguous outcome is UNCERTAIN (for Resend too: there is no queue to
// retry from), and a process that dies mid-send leaves a leased, marked row
// that lease recovery parks as UNCERTAIN (max_retries 0).
// =============================================================================

import { createLogger, makeWorkerId } from "@app/shared";
import {
  createSendNowEmailLog,
  markEmailFailed,
  markEmailSent,
  markEmailUncertain,
  type SendNowEmailLogValues,
} from "@app/db";
import { getEmailProvider } from "./providers/index";
import type { SendEmailInput } from "./providers/email-provider.types";
import { callEmailProvider, notifyStatusChange, retryOutcomeWrite } from "./queue";

const logger = createLogger({ name: "email:send-now" });

/** Lease owner of this process's send-now rows. */
const SEND_NOW_WORKER_ID = makeWorkerId("email-now");

export interface SendEmailNowInput extends Omit<SendEmailInput, "trackingId"> {
  /**
   * What the email_logs row links to (registration, abstract, template,
   * abstract trigger, context). Recipient and subject come from the message.
   */
  log?: Omit<SendNowEmailLogValues, "recipientEmail" | "recipientName" | "subject">;
}

/**
 * - `SENT`: the provider accepted it.
 * - `UNCERTAIN`: the provider may have taken it (timeout, dropped
 *   connection, unknown error). Do not send it again blind.
 * - `FAILED`: the provider refused it; nothing was sent.
 */
export type SendEmailNowResult =
  | { status: "SENT"; emailLogId: string; messageId?: string }
  | { status: "UNCERTAIN" | "FAILED"; emailLogId: string; error: string };

type SettledStatus = SendEmailNowResult["status"];

/**
 * Send one email now and record it in email_logs, owning the whole log
 * lifecycle (row, provider outcome, status notifications). Throws only when
 * the row cannot be written, before anything was sent; after the provider
 * call it never throws.
 */
export async function sendEmailNow(input: SendEmailNowInput): Promise<SendEmailNowResult> {
  const { log: links, ...message } = input;
  const provider = getEmailProvider();
  const log = await createSendNowEmailLog(
    {
      ...links,
      recipientEmail: message.to,
      recipientName: message.toName || null,
      subject: message.subject,
    },
    SEND_NOW_WORKER_ID,
    provider.name,
  );
  const emailLogId = log.id;
  notifyStatusChange(emailLogId, "SENDING");

  // The log id is the webhook correlation id and Resend's idempotency key.
  const result = await callEmailProvider(provider, { ...message, trackingId: emailLogId });
  const error = result.error || "Unknown error";
  switch (result.outcome) {
    case "accepted":
      await settle(emailLogId, "SENT", () =>
        markEmailSent(emailLogId, SEND_NOW_WORKER_ID, result.messageId),
      );
      return { status: "SENT", emailLogId, messageId: result.messageId };
    case "rejected":
      // attempt 1 of max_retries 0: FAILED, never requeued.
      await settle(emailLogId, "FAILED", () =>
        markEmailFailed(emailLogId, SEND_NOW_WORKER_ID, error, 1, 0),
      );
      return { status: "FAILED", emailLogId, error };
    case "ambiguous":
      await settle(emailLogId, "UNCERTAIN", () =>
        markEmailUncertain(
          emailLogId,
          SEND_NOW_WORKER_ID,
          `Email provider outcome unknown; not resent automatically: ${error}`,
        ),
      );
      return { status: "UNCERTAIN", emailLogId, error };
  }
}

/**
 * Record the outcome (retried like the queue's). When it cannot be written
 * the row keeps its lease and marker, and lease recovery parks it as
 * UNCERTAIN once the lease expires.
 */
async function settle(
  emailLogId: string,
  status: SettledStatus,
  write: () => Promise<boolean>,
): Promise<void> {
  const written = await retryOutcomeWrite(write);
  if (!written.ok) {
    logger.error(
      { err: written.error, emailLogId, status },
      "Send-now email outcome not recorded; lease recovery will park it as UNCERTAIN",
    );
    return;
  }
  if (!written.owned) {
    logger.warn(
      { emailLogId, status },
      "Send-now email outcome not recorded; its lease expired and recovery settled it",
    );
    return;
  }
  notifyStatusChange(emailLogId, status);
}
