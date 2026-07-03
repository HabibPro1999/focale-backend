// =============================================================================
// EMAIL QUEUE CORE
// Orchestrates the database-backed email queue: automatic-send entry points
// (queueTriggeredEmail / queueSponsorshipEmail), the worker drain loop
// (processEmailQueue), and the webhook status state-machine
// (updateEmailStatusFromWebhook).
//
// Concurrency safety is LEASE-based, not transaction-based: rows are claimed
// with FOR UPDATE SKIP LOCKED and every subsequent write re-checks lockedBy
// ownership (the @app/db primitives return false — not throw — when the lease
// was lost, which we map to a non-counted "lease-lost" outcome). This is
// deliberately NOT withTxnRetry/serializable; the semantics are lease expiry +
// ownership, not conflict retry.
// =============================================================================

import { createLogger, makeWorkerId } from "@app/shared";
import type { AutomaticEmailTrigger, EmailStatus } from "@app/contracts";
import {
  getTemplateByTrigger,
  createEmailLog,
  hasActiveEmailLogForRegistrationTrigger,
  hasActiveSponsorshipEmailLog,
  claimQueuedEmailLogs,
  getClaimedEmailLogsForProcessing,
  recoverStaleEmailLeases,
  writeResolvedSubjectIfLeaseHeld,
  refreshEmailLease,
  markEmailSent,
  markEmailFailed,
  markEmailSkipped,
  readEmailLogStatus,
  updateEmailLogStatusGuarded,
  EMAIL_LEASE_MS,
  type ClaimedEmailLog,
  type EmailLogRow,
  type EmailLogInsert,
} from "@app/db";
import { getEmailProvider } from "./providers/index";
import type { EmailAttachment } from "./providers/email-provider.types";
import { resolveVariables, buildEmailContextWithAccess } from "./rendering/index";

const logger = createLogger({ name: "email:queue" });

const MAX_RETRIES = 3;
const DEFAULT_WORKER_ID = makeWorkerId("email");

// -----------------------------------------------------------------------------
// Realtime seam. In the legacy monolith the queue emitted emailLog.statusChanged
// on the in-process EventBus. In the split architecture realtime fan-out goes
// through the outbox / EventBus in the api process, which this framework-free
// package cannot reach. The worker/api bootstrap wires a listener here.
// TODO(wave-3+): setEmailStatusChangeListener(enqueue realtime.emit outbox event).
// -----------------------------------------------------------------------------
export type EmailStatusChangeListener = (
  emailLogId: string,
  status: string,
) => void;

let statusChangeListener: EmailStatusChangeListener | undefined;

export function setEmailStatusChangeListener(
  fn: EmailStatusChangeListener | undefined,
): void {
  statusChangeListener = fn;
}

function notifyStatusChange(emailLogId: string, status: string): void {
  if (!statusChangeListener) return;
  try {
    statusChangeListener(emailLogId, status);
  } catch (err) {
    logger.warn({ err, emailLogId }, "Failed to notify emailLog status change");
  }
}

// -----------------------------------------------------------------------------
// Context helpers
// -----------------------------------------------------------------------------

type QueueEmailContext = Record<string, unknown>;

function isUsableContextSnapshot(obj: unknown): obj is Record<string, unknown> {
  if (!obj || typeof obj !== "object") return false;
  if (Array.isArray(obj)) return false;
  return Object.keys(obj).length > 0;
}

function getOptionalContextString(
  context: QueueEmailContext,
  key: string,
): string | undefined {
  const value = context[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// =============================================================================
// QUEUE EMAIL (low-level primitive)
// =============================================================================

export interface QueueEmailInput {
  trigger?: AutomaticEmailTrigger;
  registrationId?: string;
  recipientEmail: string;
  recipientName?: string;
  abstractId?: string;
  abstractTrigger?: EmailLogInsert["abstractTrigger"];
  templateId: string;
  contextSnapshot?: Record<string, unknown>;
}

/**
 * Create a QUEUED EmailLog (subject resolved later at processing time). The
 * partial-unique dedupe indexes are the race backstop: createEmailLog returns
 * `{ok:false, conflictIndex}` (rather than throwing) when a concurrent insert
 * won, which the automatic-send callers treat as an idempotent skip.
 */
export async function queueEmail(
  input: QueueEmailInput,
): Promise<
  { ok: true; log: EmailLogRow } | { ok: false; conflictIndex: string }
> {
  const result = await createEmailLog({
    trigger: input.trigger ?? null,
    templateId: input.templateId,
    registrationId: input.registrationId ?? null,
    abstractId: input.abstractId ?? null,
    abstractTrigger: input.abstractTrigger ?? null,
    recipientEmail: input.recipientEmail,
    recipientName: input.recipientName ?? null,
    subject: "",
    status: "QUEUED",
    contextSnapshot: input.contextSnapshot ?? null,
  });
  if (result.ok) notifyStatusChange(result.log.id, "QUEUED");
  return result;
}

// =============================================================================
// QUEUE TRIGGERED EMAIL (automatic sends, e.g. REGISTRATION_CREATED)
// =============================================================================

/**
 * Queue an email for an event+trigger. Returns false (no error) when no active
 * template is configured, when an active email already exists for this
 * registration+trigger, or when the DB dedupe index wins a concurrent race.
 */
export async function queueTriggeredEmail(
  trigger: AutomaticEmailTrigger,
  eventId: string,
  registration: {
    id: string;
    email: string;
    firstName?: string | null;
    lastName?: string | null;
  },
): Promise<boolean> {
  const template = await getTemplateByTrigger(eventId, trigger);
  if (!template) {
    logger.warn(
      { trigger, eventId },
      "No email template configured for trigger - email not sent",
    );
    return false;
  }

  if (await hasActiveEmailLogForRegistrationTrigger(registration.id, trigger)) {
    logger.info(
      { registrationId: registration.id, trigger },
      "Triggered email already queued, skipping duplicate",
    );
    return false;
  }

  const result = await queueEmail({
    trigger,
    templateId: template.id,
    registrationId: registration.id,
    recipientEmail: registration.email,
    recipientName:
      [registration.firstName, registration.lastName]
        .filter(Boolean)
        .join(" ") || undefined,
  });

  if (!result.ok) {
    logger.info(
      { registrationId: registration.id, trigger },
      "Triggered email already queued, skipping duplicate",
    );
    return false;
  }

  logger.info(
    { trigger, eventId, registrationId: registration.id },
    "Queued triggered email",
  );
  return true;
}

// =============================================================================
// QUEUE SPONSORSHIP EMAIL (automatic sends with a custom context snapshot)
// =============================================================================

export interface QueueSponsorshipEmailInput {
  recipientEmail: string;
  recipientName?: string;
  context: Record<string, unknown>;
  registrationId?: string;
}

/**
 * Queue a sponsorship email (SPONSORSHIP_BATCH_SUBMITTED / _LINKED / _APPLIED).
 * Dedup key is trigger+templateId+recipientEmail (+registrationId when set).
 * Same false-on-skip / false-on-race semantics as queueTriggeredEmail.
 */
export async function queueSponsorshipEmail(
  trigger: AutomaticEmailTrigger,
  eventId: string,
  input: QueueSponsorshipEmailInput,
): Promise<boolean> {
  const template = await getTemplateByTrigger(eventId, trigger);
  if (!template) {
    logger.warn(
      { trigger, eventId },
      "No email template configured for trigger - email not sent",
    );
    return false;
  }

  if (
    await hasActiveSponsorshipEmailLog({
      trigger,
      templateId: template.id,
      recipientEmail: input.recipientEmail,
      registrationId: input.registrationId,
    })
  ) {
    logger.info(
      { trigger, eventId, recipientEmail: input.recipientEmail },
      "Sponsorship email already queued, skipping duplicate",
    );
    return false;
  }

  const result = await queueEmail({
    trigger,
    templateId: template.id,
    registrationId: input.registrationId,
    recipientEmail: input.recipientEmail,
    recipientName: input.recipientName,
    contextSnapshot: input.context,
  });

  if (!result.ok) {
    logger.info(
      { trigger, eventId, recipientEmail: input.recipientEmail },
      "Sponsorship email already queued, skipping duplicate",
    );
    return false;
  }

  logger.info(
    { trigger, eventId, recipientEmail: input.recipientEmail },
    "Queued sponsorship email",
  );
  return true;
}

// =============================================================================
// CERTIFICATE ATTACHMENT HOOK (wave-3 seam)
//
// The certificate module (wave 3) owns re-fetching the registration, validating
// that the queued certificate templates are still active/in-scope, and
// rendering the PDFs. It lands as an injected generator so this package stays
// free of a certificates dependency and remains testable with a stub. The
// generator throwing (e.g. "templates no longer active") propagates to
// processEmail's catch → markEmailFailed (retryable).
// =============================================================================

export interface CertificateAttachmentContext {
  registrationId: string;
  /** From contextSnapshot._certificateTemplateIds — the templates queued. */
  certificateTemplateIds: string[];
  /** Per-batch image cache, shared across the whole processEmailQueue run. */
  imageCache: Map<string, unknown>;
}

export type CertificateAttachmentGenerator = (
  ctx: CertificateAttachmentContext,
) => Promise<EmailAttachment[]>;

// =============================================================================
// PROCESS QUEUE (worker loop)
// =============================================================================

export interface ProcessQueueResult {
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
}

export interface ProcessEmailQueueOptions {
  workerId?: string;
  leaseMs?: number;
  /** Injected by the worker (wave 3). Required to process CERTIFICATE_SENT rows. */
  generateCertificateAttachments?: CertificateAttachmentGenerator;
}

type EmailOutcome = "sent" | "failed" | "skipped" | "lease-lost";

export async function processEmailQueue(
  batchSize = 50,
  options: ProcessEmailQueueOptions = {},
): Promise<ProcessQueueResult> {
  const result: ProcessQueueResult = {
    processed: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
  };

  const workerId = options.workerId ?? DEFAULT_WORKER_ID;
  const leaseMs = options.leaseMs ?? EMAIL_LEASE_MS;
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + leaseMs);

  // Self-heal crashed workers before claiming new work.
  await recoverStaleEmailLeases(now, leaseMs);

  const claimedIds = await claimQueuedEmailLogs(
    workerId,
    batchSize,
    now,
    lockedUntil,
  );
  const batch = await getClaimedEmailLogsForProcessing(workerId, claimedIds);
  if (batch.length === 0) return result;

  result.processed = batch.length;

  const CONCURRENCY_LIMIT = 10;
  // Shared across the batch so certificate PDFs don't re-download the same image.
  const imageCache = new Map<string, unknown>();

  async function processEmail(emailLog: ClaimedEmailLog): Promise<EmailOutcome> {
    try {
      if (!emailLog.template) {
        return (await markEmailSkipped(emailLog.id, workerId, "No template found"))
          ? "skipped"
          : "lease-lost";
      }
      if (!emailLog.template.isActive) {
        return (await markEmailSkipped(
          emailLog.id,
          workerId,
          "Template is inactive",
        ))
          ? "skipped"
          : "lease-lost";
      }

      let context: QueueEmailContext | null = null;
      if (isUsableContextSnapshot(emailLog.contextSnapshot)) {
        context = emailLog.contextSnapshot;
      } else if (emailLog.registration) {
        context = (await buildEmailContextWithAccess(
          emailLog.registration,
        )) as unknown as QueueEmailContext;
      }

      if (!context || Object.keys(context).length === 0) {
        return (await markEmailSkipped(
          emailLog.id,
          workerId,
          "Could not build email context",
        ))
          ? "skipped"
          : "lease-lost";
      }

      const resolvedSubject = resolveVariables(emailLog.template.subject, context);
      const resolvedHtml = resolveVariables(
        emailLog.template.htmlContent || "",
        context,
      );
      const resolvedPlain = resolveVariables(
        emailLog.template.plainContent || "",
        context,
      );

      // Persist the resolved subject only if the lease is still held.
      if (
        !(await writeResolvedSubjectIfLeaseHeld(
          emailLog.id,
          workerId,
          resolvedSubject,
          new Date(),
        ))
      ) {
        logger.warn(
          { emailLogId: emailLog.id, workerId },
          "Email subject update skipped because lease was lost before send",
        );
        return "lease-lost";
      }

      // Certificate attachments (delegated to the wave-3 generator).
      let attachments: EmailAttachment[] | undefined;
      const certTemplateIds = context._certificateTemplateIds;
      if (
        emailLog.trigger === "CERTIFICATE_SENT" &&
        Array.isArray(certTemplateIds) &&
        certTemplateIds.length > 0 &&
        emailLog.registrationId
      ) {
        const templateIds = certTemplateIds as string[];
        const expectedCount = templateIds.length;

        if (!options.generateCertificateAttachments) {
          // TODO(wave-3): the worker must inject generateCertificateAttachments.
          throw new Error("Certificate attachment generator not configured");
        }

        attachments = await options.generateCertificateAttachments({
          registrationId: emailLog.registrationId,
          certificateTemplateIds: templateIds,
          imageCache,
        });

        if (!attachments || attachments.length === 0) {
          return (await markEmailSkipped(
            emailLog.id,
            workerId,
            "No eligible certificates to attach",
          ))
            ? "skipped"
            : "lease-lost";
        }
        if (attachments.length < expectedCount) {
          throw new Error("Fewer certificate attachments generated than queued");
        }
      }

      // Refresh the lease immediately before the network call to avoid a
      // double-send after lease expiry + requeue by another worker.
      if (!(await refreshEmailLease(emailLog.id, workerId, new Date(), leaseMs))) {
        logger.warn(
          { emailLogId: emailLog.id, workerId },
          "Email send skipped because lease was lost before provider call",
        );
        return "lease-lost";
      }

      const sendResult = await getEmailProvider().sendEmail({
        to: emailLog.recipientEmail,
        toName: emailLog.recipientName || undefined,
        fromName:
          getOptionalContextString(context, "eventName") ??
          getOptionalContextString(context, "congressName"),
        replyTo: getOptionalContextString(context, "organizerEmail"),
        replyToName: getOptionalContextString(context, "organizerName"),
        subject: resolvedSubject,
        html: resolvedHtml,
        plainText: resolvedPlain,
        trackingId: emailLog.id,
        attachments,
      });

      if (sendResult.success) {
        const ok = await markEmailSent(
          emailLog.id,
          workerId,
          sendResult.messageId,
        );
        if (ok) notifyStatusChange(emailLog.id, "SENT");
        return ok ? "sent" : "lease-lost";
      }

      return failEmail(
        emailLog,
        sendResult.error || "Unknown error",
        workerId,
      );
    } catch (error: unknown) {
      const err = error as Error;
      logger.error(
        { emailLogId: emailLog.id, error: err.message },
        "Error processing email",
      );
      return failEmail(emailLog, err.message, workerId);
    }
  }

  for (let i = 0; i < batch.length; i += CONCURRENCY_LIMIT) {
    const chunk = batch.slice(i, i + CONCURRENCY_LIMIT);
    const outcomes = await Promise.all(chunk.map(processEmail));
    for (const outcome of outcomes) {
      if (outcome === "sent") result.sent++;
      else if (outcome === "failed") result.failed++;
      else if (outcome === "skipped") result.skipped++;
      // "lease-lost" is a race, not a real failure — silently dropped.
    }
  }

  return result;
}

async function failEmail(
  emailLog: Pick<ClaimedEmailLog, "id" | "attemptCount" | "maxRetries">,
  errorMessage: string,
  workerId: string,
): Promise<EmailOutcome> {
  const ok = await markEmailFailed(
    emailLog.id,
    workerId,
    errorMessage,
    emailLog.attemptCount,
    emailLog.maxRetries,
  );
  if (ok) {
    const willRetry = emailLog.attemptCount <= (emailLog.maxRetries ?? MAX_RETRIES);
    notifyStatusChange(emailLog.id, willRetry ? "QUEUED" : "FAILED");
  }
  return ok ? "failed" : "lease-lost";
}

// =============================================================================
// WEBHOOK STATUS UPDATES
// =============================================================================

/** Forward-only ordering for non-terminal transitions. */
const STATUS_RANK: Record<string, number> = {
  QUEUED: 0,
  SENDING: 1,
  SENT: 2,
  DELIVERED: 3,
  OPENED: 4,
  CLICKED: 5,
};

/** Terminal statuses that must never be overwritten by a later webhook. */
const TERMINAL_STATUSES = new Set<EmailStatus>(["BOUNCED", "DROPPED", "FAILED"]);

export type WebhookEventType =
  | "delivered"
  | "open"
  | "click"
  | "bounce"
  | "dropped"
  | "blocked"
  | "spam_report"
  | "unsubscribe";

/**
 * Apply a provider webhook event to an EmailLog, correlated by trackingId =
 * EmailLog.id. Never throws (the webhook route always 200s once verified):
 * unknown log, terminal status, backward transition, and concurrent status
 * change are all silent no-ops; unexpected DB errors are caught + logged.
 */
export async function updateEmailStatusFromWebhook(
  emailLogId: string,
  event: WebhookEventType,
  metadata?: { url?: string; reason?: string },
): Promise<void> {
  const updates: Partial<EmailLogInsert> = {};

  switch (event) {
    case "delivered":
      updates.status = "DELIVERED";
      updates.deliveredAt = new Date();
      break;
    case "open":
      updates.status = "OPENED";
      updates.openedAt = new Date();
      break;
    case "click":
      updates.status = "CLICKED";
      updates.clickedAt = new Date();
      break;
    case "bounce":
      updates.status = "BOUNCED";
      updates.bouncedAt = new Date();
      updates.errorMessage = metadata?.reason || "Bounced";
      break;
    case "dropped":
      updates.status = "DROPPED";
      updates.errorMessage = metadata?.reason || "Dropped";
      break;
    case "blocked":
      updates.status = "DROPPED";
      updates.errorMessage = metadata?.reason || "Blocked by SendGrid";
      break;
    case "spam_report":
      updates.status = "BOUNCED";
      updates.bouncedAt = new Date();
      updates.errorMessage =
        metadata?.reason || "Recipient reported email as spam";
      break;
    case "unsubscribe":
      updates.status = "BOUNCED";
      updates.bouncedAt = new Date();
      updates.errorMessage = metadata?.reason || "Recipient unsubscribed";
      break;
  }

  try {
    const currentStatus = await readEmailLogStatus(emailLogId);
    if (!currentStatus) {
      logger.warn(
        { emailLogId, event },
        "Webhook received for unknown email log — skipping",
      );
      return;
    }

    if (TERMINAL_STATUSES.has(currentStatus)) {
      logger.info(
        { emailLogId, event, currentStatus },
        "Webhook skipped — email already in terminal status",
      );
      return;
    }

    const newStatus = updates.status;
    if (newStatus && !TERMINAL_STATUSES.has(newStatus)) {
      const currentRank = STATUS_RANK[currentStatus] ?? -1;
      const newRank = STATUS_RANK[newStatus] ?? -1;
      if (newRank <= currentRank) {
        logger.info(
          { emailLogId, event, currentStatus, newStatus },
          "Webhook skipped — would be a backward status transition",
        );
        return;
      }
    }

    const changed = await updateEmailLogStatusGuarded(
      emailLogId,
      currentStatus,
      updates,
    );
    if (!changed) {
      logger.info(
        { emailLogId, event, currentStatus },
        "Webhook skipped — email status changed concurrently",
      );
      return;
    }
    if (updates.status) notifyStatusChange(emailLogId, updates.status);
  } catch (error) {
    logger.error(
      { emailLogId, event, error },
      "Failed to update email status from webhook",
    );
  }
}
