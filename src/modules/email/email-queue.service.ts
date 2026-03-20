// =============================================================================
// EMAIL QUEUE SERVICE
// Manages the database-backed email queue for reliable delivery with retries
// =============================================================================

import { prisma } from "@/database/client.js";
import { logger } from "@shared/utils/logger.js";
import { sendEmail } from "./email-sendgrid.service.js";
import {
  resolveVariables,
  buildEmailContextWithAccess,
} from "./email-variable.service.js";
import { getTemplateByTrigger } from "./email-template.service.js";
import { Prisma } from "@/generated/prisma/client.js";
import type { EmailContext } from "./email.types.js";
import type { AutomaticEmailTrigger } from "./email.schema.js";

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
  const emailLogs = registrations.map((reg) => ({
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

export async function processEmailQueue(
  batchSize = 50,
): Promise<ProcessQueueResult> {
  const result: ProcessQueueResult = {
    processed: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
  };

  // Get batch of queued emails with row-level locking
  const batch = await prisma.$transaction(async (tx) => {
    const emails = await tx.emailLog.findMany({
      where: {
        status: "QUEUED",
        // Process emails that haven't exceeded max retries
        retryCount: { lt: 4 },
      },
      take: batchSize * 2, // Fetch more to account for backoff filtering
      orderBy: { queuedAt: "asc" },
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

    // Filter emails that are ready for retry (respect backoff timing)
    const readyEmails = emails.filter(isReadyForRetry).slice(0, batchSize);

    if (readyEmails.length > 0) {
      await tx.emailLog.updateMany({
        where: { id: { in: readyEmails.map((e: { id: string }) => e.id) } },
        data: { status: "SENDING" },
      });
    }

    return readyEmails;
  });

  if (batch.length === 0) {
    return result;
  }

  result.processed = batch.length;

  // Process emails in parallel with controlled concurrency
  const CONCURRENCY_LIMIT = 10;

  // Process a single email and return the outcome
  async function processEmail(
    emailLog: (typeof batch)[number],
  ): Promise<"sent" | "failed" | "skipped"> {
    try {
      // Skip if no template
      if (!emailLog.template) {
        await markAsSkipped(emailLog.id, "No template found");
        return "skipped";
      }

      // Skip if template is inactive
      if (!emailLog.template.isActive) {
        await markAsSkipped(emailLog.id, "Template is inactive");
        return "skipped";
      }

      // Build context
      let context: EmailContext | null = null;

      if (
        emailLog.contextSnapshot &&
        isValidEmailContext(emailLog.contextSnapshot)
      ) {
        context = emailLog.contextSnapshot;
      } else if (emailLog.registration) {
        // Build context from registration
        context = await buildEmailContextWithAccess(
          emailLog.registration as RegistrationWithRelations,
        );
      }

      if (!context || Object.keys(context).length === 0) {
        await markAsSkipped(emailLog.id, "Could not build email context");
        return "skipped";
      }

      // Resolve variables
      const resolvedSubject = resolveVariables(
        emailLog.template.subject,
        context,
      );
      const resolvedHtml = resolveVariables(
        emailLog.template.htmlContent || "",
        context,
      );
      const resolvedPlain = resolveVariables(
        emailLog.template.plainContent || "",
        context,
      );

      // Update subject in log
      await prisma.emailLog.update({
        where: { id: emailLog.id },
        data: { subject: resolvedSubject },
      });

      // Send via SendGrid
      const sendResult = await sendEmail({
        to: emailLog.recipientEmail,
        toName: emailLog.recipientName || undefined,
        fromName: context.eventName,
        replyTo: context.organizerEmail || undefined,
        replyToName: context.organizerName || undefined,
        subject: resolvedSubject,
        html: resolvedHtml,
        plainText: resolvedPlain,
        trackingId: emailLog.id,
      });

      if (sendResult.success) {
        await markAsSent(emailLog.id, sendResult.messageId);
        return "sent";
      } else {
        await markAsFailed(
          emailLog.id,
          sendResult.error || "Unknown error",
          emailLog.retryCount,
        );
        return "failed";
      }
    } catch (error: unknown) {
      const err = error as Error;
      logger.error(
        { emailLogId: emailLog.id, error: err.message },
        "Error processing email",
      );
      await markAsFailed(emailLog.id, err.message, emailLog.retryCount);
      return "failed";
    }
  }

  // Process in chunks to limit concurrency
  for (let i = 0; i < batch.length; i += CONCURRENCY_LIMIT) {
    const chunk = batch.slice(i, i + CONCURRENCY_LIMIT);
    const outcomes = await Promise.all(chunk.map(processEmail));

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
) {
  const maxRetries = 3;
  const shouldRetry = currentRetryCount < maxRetries;

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

export async function updateEmailStatusFromWebhook(
  emailLogId: string,
  event: "delivered" | "open" | "click" | "bounce" | "dropped" | "blocked",
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
    case "blocked":
      updates.status = "DROPPED";
      updates.errorMessage = metadata?.reason || "Blocked by SendGrid";
      break;
  }

  try {
    await prisma.emailLog.update({
      where: { id: emailLogId },
      data: updates,
    });
  } catch (error) {
    logger.error(
      { emailLogId, event, error },
      "Failed to update email status from webhook",
    );
  }
}

// =============================================================================
// UTILITIES
// =============================================================================

/**
 * Calculate backoff time for retry.
 * Exponential backoff: 1min, 5min, 15min
 */
function getBackoffMs(retryCount: number): number {
  const backoffs = [60000, 300000, 900000]; // 1min, 5min, 15min
  return backoffs[Math.min(retryCount, backoffs.length - 1)];
}

/**
 * Check if an email is ready for retry based on backoff timing.
 */
function isReadyForRetry(email: {
  retryCount: number;
  updatedAt: Date;
}): boolean {
  if (email.retryCount === 0) return true;
  const backoffMs = getBackoffMs(email.retryCount - 1);
  const readyAt = new Date(email.updatedAt.getTime() + backoffMs);
  return new Date() >= readyAt;
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
