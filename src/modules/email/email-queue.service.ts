// =============================================================================
// EMAIL QUEUE SERVICE
// Manages the database-backed email queue for reliable delivery with retries
// =============================================================================

import { prisma } from "@/database/client.js";
import { logger } from "@shared/utils/logger.js";
import { sendEmail } from "./email-sendgrid.service.js";
import {
  resolveVariables,
  resolveVariablesHtml,
  buildEmailContextWithAccess,
} from "./email-variable.service.js";
import { getTemplateByTrigger } from "./email-template.service.js";
import { Prisma } from "@/generated/prisma/client.js";
import type { EmailContext } from "./email.types.js";
import type { AutomaticEmailTrigger } from "./email.schema.js";

// =============================================================================
// CONSTANTS
// =============================================================================

const MAX_RETRIES = 3;

// =============================================================================
// TYPES
// =============================================================================

// Type for registration with all needed relations for email context building
type RegistrationWithRelations = Prisma.RegistrationGetPayload<{
  include: {
    event: {
      include: { client: true };
    };
    form: true;
  };
}>;

// Email status enum (mirrors Prisma enum)
type EmailStatus =
  | "QUEUED"
  | "SENDING"
  | "SENT"
  | "DELIVERED"
  | "OPENED"
  | "CLICKED"
  | "BOUNCED"
  | "DROPPED"
  | "FAILED"
  | "SKIPPED";

// Type guard for EmailContext - validates required fields at runtime
function isValidEmailContext(obj: unknown): obj is EmailContext {
  if (!obj || typeof obj !== "object") return false;
  const ctx = obj as Record<string, unknown>;
  // Check for essential required fields
  return (
    typeof ctx.firstName === "string" &&
    typeof ctx.email === "string" &&
    typeof ctx.eventName === "string"
  );
}

// =============================================================================
// QUEUE EMAIL
// =============================================================================

export interface QueueEmailInput {
  // Source
  trigger?: AutomaticEmailTrigger; // null = manual send

  // Target
  registrationId?: string;
  recipientEmail: string;
  recipientName?: string;

  // Template
  templateId: string;

  // Pre-built context (optional)
  contextSnapshot?: Record<string, unknown>;
}

export async function queueEmail(input: QueueEmailInput) {
  return prisma.emailLog.create({
    data: {
      trigger: input.trigger,
      templateId: input.templateId,
      registrationId: input.registrationId,
      recipientEmail: input.recipientEmail,
      recipientName: input.recipientName,
      subject: "", // Will be resolved when processing
      status: "QUEUED",
      contextSnapshot: (input.contextSnapshot ??
        Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });
}

// =============================================================================
// QUEUE TRIGGERED EMAIL (For Automatic Sends)
// =============================================================================

/**
 * Queue an email based on a trigger event (e.g., REGISTRATION_CREATED).
 * Looks up the active template for the event+trigger, returns false if none exists.
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
  // 1. Get active template for this event + trigger
  const template = await getTemplateByTrigger(eventId, trigger);
  if (!template) {
    logger.warn(
      { trigger, eventId },
      "No email template configured for trigger - email not sent",
    );
    return false;
  }

  // 2. Queue the email
  await queueEmail({
    trigger,
    templateId: template.id,
    registrationId: registration.id,
    recipientEmail: registration.email,
    recipientName:
      [registration.firstName, registration.lastName]
        .filter(Boolean)
        .join(" ") || undefined,
  });

  logger.info(
    { trigger, eventId, registrationId: registration.id },
    "Queued triggered email",
  );
  return true;
}

// =============================================================================
// QUEUE SPONSORSHIP EMAIL (With Custom Context)
// =============================================================================

export interface QueueSponsorshipEmailInput {
  recipientEmail: string;
  recipientName?: string;
  context: Record<string, unknown>;
  registrationId?: string; // Optional - only for doctor emails linked to a registration
}

/**
 * Queue a sponsorship-related email with custom context.
 * Used for SPONSORSHIP_BATCH_SUBMITTED, SPONSORSHIP_LINKED, SPONSORSHIP_APPLIED.
 */
export async function queueSponsorshipEmail(
  trigger: AutomaticEmailTrigger,
  eventId: string,
  input: QueueSponsorshipEmailInput,
): Promise<boolean> {
  // 1. Get active template for this event + trigger
  const template = await getTemplateByTrigger(eventId, trigger);
  if (!template) {
    logger.warn(
      { trigger, eventId },
      "No email template configured for trigger - email not sent",
    );
    return false;
  }

  // 2. Queue the email with custom context
  await queueEmail({
    trigger,
    templateId: template.id,
    registrationId: input.registrationId,
    recipientEmail: input.recipientEmail,
    recipientName: input.recipientName,
    contextSnapshot: input.context,
  });

  logger.info(
    { trigger, eventId, recipientEmail: input.recipientEmail },
    "Queued sponsorship email",
  );
  return true;
}

// =============================================================================
// QUEUE BULK EMAILS (For Manual Sends)
// =============================================================================

export async function queueBulkEmails(
  templateId: string,
  registrations: Array<{
    id: string;
    email: string;
    firstName?: string | null;
    lastName?: string | null;
  }>,
): Promise<number> {
  // Deduplication: find registrations that already have QUEUED/SENDING emails for this template
  const existingLogs = await prisma.emailLog.findMany({
    where: {
      templateId,
      registrationId: { in: registrations.map((r) => r.id) },
      status: { in: ["QUEUED", "SENDING"] },
    },
    select: { registrationId: true },
  });

  const alreadyQueued = new Set(
    existingLogs
      .map((l) => l.registrationId)
      .filter((id): id is string => id !== null),
  );
  const filteredRegistrations = registrations.filter(
    (r) => !alreadyQueued.has(r.id),
  );

  if (filteredRegistrations.length === 0) {
    return 0;
  }

  const emailLogs = filteredRegistrations.map((reg) => ({
    templateId,
    registrationId: reg.id,
    recipientEmail: reg.email,
    recipientName:
      [reg.firstName, reg.lastName].filter(Boolean).join(" ") || null,
    subject: "",
    status: "QUEUED" as EmailStatus,
  }));

  const result = await prisma.emailLog.createMany({
    data: emailLogs,
  });

  return result.count;
}

// =============================================================================
// PROCESS QUEUE (Background Worker)
// =============================================================================

export interface ProcessQueueResult {
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
}

// Type alias for the email log records returned by claimAndFetchEmailBatch
type EmailLogWithRelations = Awaited<
  ReturnType<typeof claimAndFetchEmailBatch>
>[number];

// Recover stale SENDING emails (stuck for > 10 minutes) back to QUEUED.
// Returns the count of recovered emails.
async function recoverStaleEmails(): Promise<number> {
  const recovered = await prisma.$executeRaw`
    UPDATE email_logs SET status = 'QUEUED', updated_at = NOW()
    WHERE status = 'SENDING' AND updated_at < NOW() - INTERVAL '10 minutes' AND retry_count < ${MAX_RETRIES + 1}
  `;
  if (recovered > 0) {
    logger.warn({ recovered }, "Recovered stale SENDING emails back to QUEUED");
  }
  return recovered;
}

// Atomically claim a batch of queued emails with row-level locking (exponential
// backoff enforced in SQL), then fetch full records with relations.
async function claimAndFetchEmailBatch(batchSize: number) {
  const claimedIds = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "email_logs"
    SET status = 'SENDING', updated_at = NOW()
    WHERE id IN (
      SELECT id FROM "email_logs"
      WHERE status = 'QUEUED'
        AND retry_count < ${MAX_RETRIES + 1}
        AND (
          retry_count = 0
          OR updated_at <= NOW() - CASE
            WHEN retry_count = 1 THEN INTERVAL '1 minute'
            WHEN retry_count = 2 THEN INTERVAL '5 minutes'
            ELSE INTERVAL '15 minutes'
          END
        )
      ORDER BY queued_at ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `;

  if (claimedIds.length === 0) return [];

  return prisma.emailLog.findMany({
    where: { id: { in: claimedIds.map((r) => r.id) } },
    include: {
      template: true,
      registration: {
        include: {
          event: { include: { client: true } },
          form: true,
        },
      },
    },
  });
}

// Validate template presence and active status. Returns a skip reason string
// if the email should be skipped, or null if it can proceed.
async function validateAndSkipEmail(
  emailLog: EmailLogWithRelations,
): Promise<string | null> {
  if (!emailLog.template) {
    await markAsSkipped(emailLog.id, "No template found");
    return "No template found";
  }
  if (!emailLog.template.isActive) {
    await markAsSkipped(emailLog.id, "Template is inactive");
    return "Template is inactive";
  }
  return null;
}

// Build context, resolve variables, and send the email via the provider.
// Returns "sent", "failed", or "skipped" (when context cannot be built).
async function buildAndSendEmail(
  emailLog: EmailLogWithRelations,
): Promise<"sent" | "failed" | "skipped"> {
  // Build context from snapshot or registration
  let context: EmailContext | null = null;
  if (emailLog.contextSnapshot && isValidEmailContext(emailLog.contextSnapshot)) {
    context = emailLog.contextSnapshot;
  } else if (emailLog.registration) {
    context = await buildEmailContextWithAccess(
      emailLog.registration as RegistrationWithRelations,
    );
  }

  if (!context || Object.keys(context).length === 0) {
    await markAsSkipped(emailLog.id, "Could not build email context");
    return "skipped";
  }

  // template is guaranteed non-null here (validated before this call)
  const template = emailLog.template!;
  const resolvedSubject = resolveVariables(template.subject, context);
  const resolvedHtml = resolveVariablesHtml(template.htmlContent || "", context);
  const resolvedPlain = resolveVariables(template.plainContent || "", context);

  await prisma.emailLog.update({
    where: { id: emailLog.id },
    data: { subject: resolvedSubject },
  });

  const sendResult = await sendEmail({
    to: emailLog.recipientEmail,
    toName: emailLog.recipientName || undefined,
    fromName: context.eventName,
    subject: resolvedSubject,
    html: resolvedHtml,
    plainText: resolvedPlain,
    trackingId: emailLog.id,
  });

  if (sendResult.success) {
    await markAsSent(emailLog.id, sendResult.messageId);
    return "sent";
  }

  await markAsFailed(
    emailLog.id,
    sendResult.error || "Unknown error",
    emailLog.retryCount,
    { templateId: emailLog.templateId, registrationId: emailLog.registrationId },
  );
  return "failed";
}

// Process a single email log record: validate, build context, send.
// Returns the outcome: "sent", "failed", or "skipped".
async function processSingleEmail(
  emailLog: EmailLogWithRelations,
): Promise<"sent" | "failed" | "skipped"> {
  try {
    const skipReason = await validateAndSkipEmail(emailLog);
    if (skipReason !== null) return "skipped";

    return await buildAndSendEmail(emailLog);
  } catch (error: unknown) {
    const err = error as Error;
    logger.error(
      { emailLogId: emailLog.id, error: err.message },
      "Error processing email",
    );
    await markAsFailed(emailLog.id, err.message, emailLog.retryCount, {
      templateId: emailLog.templateId,
      registrationId: emailLog.registrationId,
    });
    return "failed";
  }
}

export async function processEmailQueue(
  batchSize = 50,
): Promise<ProcessQueueResult> {
  const result: ProcessQueueResult = {
    processed: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
  };

  await recoverStaleEmails();

  const batch = await claimAndFetchEmailBatch(batchSize);
  if (batch.length === 0) return result;

  result.processed = batch.length;

  const CONCURRENCY_LIMIT = 10;
  for (let i = 0; i < batch.length; i += CONCURRENCY_LIMIT) {
    const chunk = batch.slice(i, i + CONCURRENCY_LIMIT);
    const outcomes = await Promise.all(chunk.map(processSingleEmail));
    for (const outcome of outcomes) {
      if (outcome === "sent") result.sent++;
      else if (outcome === "failed") result.failed++;
      else result.skipped++;
    }
  }

  return result;
}

// =============================================================================
// STATUS UPDATES
// =============================================================================

async function markAsSent(id: string, messageId?: string) {
  await prisma.emailLog.update({
    where: { id },
    data: {
      status: "SENT",
      sendgridMessageId: messageId,
      sentAt: new Date(),
    },
  });
}

async function markAsFailed(
  id: string,
  errorMessage: string,
  currentRetryCount: number,
  meta?: { templateId?: string | null; registrationId?: string | null },
) {
  const shouldRetry = currentRetryCount < MAX_RETRIES;

  if (!shouldRetry) {
    logger.warn(
      {
        templateId: meta?.templateId,
        registrationId: meta?.registrationId,
        error: errorMessage,
        retryCount: currentRetryCount + 1,
      },
      "email.permanent_failure",
    );
  }

  await prisma.emailLog.update({
    where: { id },
    data: {
      status: shouldRetry ? "QUEUED" : "FAILED",
      errorMessage,
      retryCount: { increment: 1 },
      failedAt: shouldRetry ? null : new Date(),
    },
  });
}

async function markAsSkipped(id: string, reason: string) {
  await prisma.emailLog.update({
    where: { id },
    data: {
      status: "SKIPPED",
      errorMessage: reason,
    },
  });
}

// =============================================================================
// WEBHOOK STATUS UPDATES
// =============================================================================

interface EmailLogUpdateData {
  status?: EmailStatus;
  deliveredAt?: Date;
  openedAt?: Date;
  clickedAt?: Date;
  bouncedAt?: Date;
  errorMessage?: string;
}

// Non-terminal statuses in ascending rank order.
// Terminal statuses (BOUNCED, DROPPED, FAILED, SKIPPED) are not listed here
// because they are endpoint states and never upgraded by subsequent webhook events.
const NON_TERMINAL_STATUSES: EmailStatus[] = [
  "QUEUED",
  "SENDING",
  "SENT",
  "DELIVERED",
  "OPENED",
  "CLICKED",
];

// For each incoming event, the set of current statuses that are allowed to be
// overwritten by the new status. This encodes the monotonicity rule directly
// as an IN-list used inside the WHERE clause of the UPDATE, making the entire
// read-check-write atomic at the database level.
//
// Terminal failure events (bounce, dropped) may overwrite any non-terminal
// status. Non-terminal events may only overwrite statuses with strictly lower
// rank (i.e. statuses that appear earlier in NON_TERMINAL_STATUSES).
const VALID_PREDECESSOR_STATUSES: Record<
  "delivered" | "open" | "click" | "bounce" | "dropped",
  EmailStatus[]
> = {
  // DELIVERED (rank 3): upgrades QUEUED(0), SENDING(1), SENT(2)
  delivered: ["QUEUED", "SENDING", "SENT"],
  // OPENED (rank 4): upgrades everything below it
  open: ["QUEUED", "SENDING", "SENT", "DELIVERED"],
  // CLICKED (rank 5): upgrades everything below it
  click: ["QUEUED", "SENDING", "SENT", "DELIVERED", "OPENED"],
  // Terminal — overwrites any non-terminal state
  bounce: NON_TERMINAL_STATUSES,
  dropped: NON_TERMINAL_STATUSES,
};

export async function updateEmailStatusFromWebhook(
  emailLogId: string,
  event: "delivered" | "open" | "click" | "bounce" | "dropped",
  metadata?: { url?: string; reason?: string },
) {
  const updates: EmailLogUpdateData = {};

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
  }

  if (!updates.status) return;

  const validPredecessors = VALID_PREDECESSOR_STATUSES[event];

  try {
    // Atomic conditional update: the WHERE clause enforces monotonicity at the
    // database level. No separate read is needed — if the current status is not
    // in the valid predecessor list (i.e. it is already at a higher rank or is
    // terminal), the UPDATE matches zero rows and is silently ignored.
    const result = await prisma.emailLog.updateMany({
      where: {
        id: emailLogId,
        status: { in: validPredecessors },
      },
      data: updates,
    });

    if (result.count === 0) {
      logger.debug(
        { emailLogId, event, newStatus: updates.status },
        "Skipping webhook status update — current status is already equal or higher rank (atomic check)",
      );
    }
  } catch (error) {
    logger.error(
      { emailLogId, event, error },
      "Failed to update email status from webhook",
    );
  }
}

// =============================================================================
// TEMPLATE SAFETY CHECKS
// =============================================================================

/**
 * Get count of queued or sending emails for a template
 * Used to prevent deletion of templates with active email jobs
 */
export async function getQueuedEmailCountForTemplate(
  templateId: string,
): Promise<number> {
  return prisma.emailLog.count({
    where: {
      templateId,
      status: { in: ["QUEUED", "SENDING"] },
    },
  });
}

// =============================================================================
// QUEUE STATS
// =============================================================================

export async function getQueueStats() {
  const stats = await prisma.emailLog.groupBy({
    by: ["status"],
    _count: { status: true },
  });

  return stats.reduce(
    (
      acc: Record<string, number>,
      s: { status: string; _count: { status: number } },
    ) => {
      acc[s.status] = s._count.status;
      return acc;
    },
    {} as Record<string, number>,
  );
}
