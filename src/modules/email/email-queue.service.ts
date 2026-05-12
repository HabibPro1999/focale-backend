// =============================================================================
// EMAIL QUEUE SERVICE
// Manages the database-backed email queue for reliable delivery with retries
// =============================================================================

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { prisma } from "@/database/client.js";
import { logger } from "@shared/utils/logger.js";
import { sendEmail } from "./email-sendgrid.service.js";
import type { EmailAttachment } from "./email-sendgrid.service.js";
import {
  resolveVariables,
  buildEmailContextWithAccess,
} from "./email-variable.service.js";
import { getTemplateByTrigger } from "./email-template.service.js";
import { Prisma } from "@/generated/prisma/client.js";
import type { AbstractEmailTrigger } from "@/generated/prisma/client.js";
import type { EmailContext, RegistrationWithRelations } from "./email.types.js";
import type { AutomaticEmailTrigger } from "./email.schema.js";
import type { ImageCache } from "@modules/certificates/certificate-pdf.service.js";
import type { CertificateZone } from "@modules/certificates/certificates.schema.js";
import { eventBus } from "@core/events/bus.js";

/**
 * Emit a realtime emailLog.statusChanged event.
 * Fetches the client/event scope via join. Fails silently if the log or
 * registration relation is missing — realtime is best-effort.
 */
async function emitEmailLogChanged(
  emailLogId: string,
  status: string,
): Promise<void> {
  try {
    const log = await prisma.emailLog.findUnique({
      where: { id: emailLogId },
      select: {
        registrationId: true,
        registration: {
          select: {
            eventId: true,
            event: { select: { clientId: true } },
          },
        },
      },
    });
    const clientId = log?.registration?.event?.clientId;
    const eventId = log?.registration?.eventId;
    if (!clientId || !eventId) return;
    eventBus.emit({
      type: "emailLog.statusChanged",
      clientId,
      eventId,
      payload: {
        id: emailLogId,
        status,
        registrationId: log.registrationId ?? undefined,
      },
      ts: Date.now(),
    });
  } catch (err) {
    logger.warn({ err, emailLogId }, "Failed to emit emailLog.statusChanged");
  }
}

// =============================================================================
// TYPES
// =============================================================================

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

const MAX_RETRIES = 3;
const EMAIL_LEASE_MS = 10 * 60 * 1000;
const EMAIL_QUEUE_UNHEALTHY_AGE_MS = 30 * 60 * 1000;
const EMAIL_QUEUE_UNHEALTHY_SIZE = 1000;
const DEFAULT_WORKER_ID = `email:${hostname()}:${process.pid}:${randomUUID()}`;

export interface ProcessEmailQueueOptions {
  workerId?: string;
  leaseMs?: number;
}

function emailRetryDelayMs(failedAttemptCount: number): number {
  if (failedAttemptCount <= 1) return 60 * 1000;
  if (failedAttemptCount === 2) return 5 * 60 * 1000;
  return 15 * 60 * 1000;
}

function nextEmailAttemptAt(failedAttemptCount: number, from = new Date()): Date {
  return new Date(from.getTime() + emailRetryDelayMs(failedAttemptCount));
}

function clearEmailLeaseFields() {
  return {
    lockedAt: null,
    lockedUntil: null,
    lockedBy: null,
  };
}

/** Status ordering for webhook state machine — only forward transitions allowed */
const STATUS_RANK: Record<string, number> = {
  QUEUED: 0,
  SENDING: 1,
  SENT: 2,
  DELIVERED: 3,
  OPENED: 4,
  CLICKED: 5,
};

/** Terminal statuses that cannot be overwritten — must match EmailStatus enum in schema.prisma */
const TERMINAL_STATUSES = new Set(["BOUNCED", "DROPPED", "FAILED"]);

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
  abstractId?: string;
  abstractTrigger?: AbstractEmailTrigger;

  // Template
  templateId: string;

  // Pre-built context (optional)
  contextSnapshot?: Record<string, unknown>;
}

export async function queueEmail(input: QueueEmailInput) {
  const created = await prisma.emailLog.create({
    data: {
      trigger: input.trigger,
      templateId: input.templateId,
      registrationId: input.registrationId,
      abstractId: input.abstractId,
      abstractTrigger: input.abstractTrigger,
      recipientEmail: input.recipientEmail,
      recipientName: input.recipientName,
      subject: "", // Will be resolved when processing
      status: "QUEUED",
      contextSnapshot: (input.contextSnapshot ??
        Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });
  void emitEmailLogChanged(created.id, "QUEUED");
  return created;
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

  // 2. Check for duplicate: skip if an email with the same registration + trigger
  //    is already queued, sending, sent, or delivered
  const existing = await prisma.emailLog.findFirst({
    where: {
      registrationId: registration.id,
      trigger: trigger,
      status: { in: ["QUEUED", "SENDING", "SENT", "DELIVERED"] },
    },
  });
  if (existing) {
    logger.info(
      { registrationId: registration.id, trigger },
      "Triggered email already queued, skipping duplicate",
    );
    return false;
  }

  // 3. Queue the email
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
// QUEUE BULK SPONSOR EMAILS (For Manual Sends to Lab Contacts)
// =============================================================================

export async function queueBulkSponsorEmails(
  templateId: string,
  sponsors: Array<{
    email: string;
    recipientName: string;
    contextSnapshot: Record<string, unknown>;
  }>,
): Promise<number> {
  const valid = sponsors.filter((s) => s.email.trim().length > 0);
  if (valid.length === 0) return 0;

  const emailLogs = valid.map((s) => ({
    templateId,
    recipientEmail: s.email,
    recipientName: s.recipientName || null,
    subject: "",
    status: "QUEUED" as EmailStatus,
    contextSnapshot: s.contextSnapshot as Prisma.InputJsonValue,
  }));

  const result = await prisma.emailLog.createMany({
    data: emailLogs,
  });

  return result.count;
}

// =============================================================================
// QUEUE CERTIFICATE EMAILS (With Attachments)
// =============================================================================

export interface QueueCertificateEmailInput {
  registrationId: string;
  recipientEmail: string;
  recipientName?: string;
  certificateTemplateIds: string[];
  certificateNames: string[];
  contextSnapshot: Record<string, unknown>;
}

/**
 * Queue a certificate email for a single registrant.
 * Stores certificate template IDs in contextSnapshot for PDF generation at processing time.
 * Returns the email log ID, or null if duplicate (already sent).
 */
export async function queueCertificateEmail(
  emailTemplateId: string,
  input: QueueCertificateEmailInput,
): Promise<string | null> {
  // Dedup at the certificate-template level: only skip a certificate the
  // registrant has already received. If new templates have become eligible
  // (e.g. after a belated access check-in or a fix to the template's accessId),
  // we still queue a new email for the remaining ones.
  const alreadySentIds = await getAlreadySentCertTemplateIds([
    input.registrationId,
  ]);
  const sentSet = alreadySentIds.get(input.registrationId) ?? new Set<string>();

  const remaining = input.certificateTemplateIds
    .map((id, idx) => ({ id, name: input.certificateNames[idx] }))
    .filter((x) => !sentSet.has(x.id));

  if (remaining.length === 0) return null;

  const remainingIds = remaining.map((x) => x.id);
  const remainingNames = remaining.map((x) => x.name);

  const context = {
    ...input.contextSnapshot,
    certificateCount: String(remainingIds.length),
    certificateList: remainingNames.join(", "),
    _certificateTemplateIds: remainingIds,
  };

  const log = await prisma.emailLog.create({
    data: {
      trigger: "CERTIFICATE_SENT",
      templateId: emailTemplateId,
      registrationId: input.registrationId,
      recipientEmail: input.recipientEmail,
      recipientName: input.recipientName ?? null,
      subject: "",
      status: "QUEUED",
      contextSnapshot: context as Prisma.InputJsonValue,
    },
  });

  return log.id;
}

/**
 * Collect the set of certificate template IDs that have already been
 * queued/sent/delivered for each registration. Reads _certificateTemplateIds
 * from the stored contextSnapshot of prior CERTIFICATE_SENT email logs.
 */
async function getAlreadySentCertTemplateIds(
  registrationIds: string[],
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  if (registrationIds.length === 0) return result;

  const logs = await prisma.emailLog.findMany({
    where: {
      registrationId: { in: registrationIds },
      trigger: "CERTIFICATE_SENT",
      status: { in: ["QUEUED", "SENDING", "SENT", "DELIVERED"] },
    },
    select: { registrationId: true, contextSnapshot: true },
  });

  for (const log of logs) {
    if (!log.registrationId) continue;
    const ctx = log.contextSnapshot as Record<string, unknown> | null;
    const ids = ctx?._certificateTemplateIds;
    if (!Array.isArray(ids)) continue;

    let set = result.get(log.registrationId);
    if (!set) {
      set = new Set<string>();
      result.set(log.registrationId, set);
    }
    for (const id of ids) {
      if (typeof id === "string") set.add(id);
    }
  }

  return result;
}

/**
 * Queue certificate emails for multiple registrants.
 * Each registrant gets one email with all eligible certificates attached.
 * Batch dedup: single query to find already-sent registrations, then bulk insert.
 */
export async function queueBulkCertificateEmails(
  emailTemplateId: string,
  inputs: QueueCertificateEmailInput[],
): Promise<{ queued: number; skipped: number }> {
  if (inputs.length === 0) return { queued: 0, skipped: 0 };

  // Per-template dedup: a registrant gets skipped only if ALL their eligible
  // certificate templates have already been queued/sent. If some are new
  // (e.g. the admin added a template, checked them into a new access, or
  // fixed a template.accessId mapping), queue those remaining ones.
  const regIds = inputs.map((i) => i.registrationId);
  const alreadySentIds = await getAlreadySentCertTemplateIds(regIds);

  type PreparedInput = {
    input: QueueCertificateEmailInput;
    remainingIds: string[];
    remainingNames: string[];
  };

  const prepared: PreparedInput[] = inputs.map((input) => {
    const sentSet =
      alreadySentIds.get(input.registrationId) ?? new Set<string>();
    const pairs = input.certificateTemplateIds
      .map((id, idx) => ({ id, name: input.certificateNames[idx] }))
      .filter((x) => !sentSet.has(x.id));

    return {
      input,
      remainingIds: pairs.map((p) => p.id),
      remainingNames: pairs.map((p) => p.name),
    };
  });

  const toQueue = prepared.filter((p) => p.remainingIds.length > 0);
  const skipped = prepared.length - toQueue.length;

  if (toQueue.length === 0) return { queued: 0, skipped };

  // Bulk insert remaining templates only
  const data = toQueue.map(({ input, remainingIds, remainingNames }) => {
    const context = {
      ...input.contextSnapshot,
      certificateCount: String(remainingIds.length),
      certificateList: remainingNames.join(", "),
      _certificateTemplateIds: remainingIds,
    };

    return {
      trigger: "CERTIFICATE_SENT" as const,
      templateId: emailTemplateId,
      registrationId: input.registrationId,
      recipientEmail: input.recipientEmail,
      recipientName: input.recipientName ?? null,
      subject: "",
      status: "QUEUED" as const,
      contextSnapshot: context as Prisma.InputJsonValue,
    };
  });

  const result = await prisma.emailLog.createMany({ data });

  return { queued: result.count, skipped };
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

export async function recoverStaleEmailLeases(
  now = new Date(),
  leaseMs = EMAIL_LEASE_MS,
) {
  const staleCutoff = new Date(now.getTime() - leaseMs);
  const retry1At = nextEmailAttemptAt(1, now);
  const retry2At = nextEmailAttemptAt(2, now);
  const retryLaterAt = nextEmailAttemptAt(3, now);

  const requeued = await prisma.$executeRawUnsafe(
    `UPDATE "email_logs"
     SET
       "status" = 'QUEUED',
       "updated_at" = $1,
       "locked_at" = NULL,
       "locked_until" = NULL,
       "locked_by" = NULL,
       "retry_count" = "retry_count" + 1,
       "next_attempt_at" = CASE
         WHEN "attempt_count" <= 1 THEN $3
         WHEN "attempt_count" = 2 THEN $4
         ELSE $5
       END,
       "error_message" = COALESCE("error_message", 'Email send lease expired; requeued for retry')
     WHERE "status" = 'SENDING'
       AND (
         "locked_until" < $1
         OR (
           "locked_until" IS NULL
           AND COALESCE("locked_at", "last_attempt_at", "updated_at") < $2
         )
       )
       AND "retry_count" < "max_retries"`,
    now,
    staleCutoff,
    retry1At,
    retry2At,
    retryLaterAt,
  );

  const deadLettered = await prisma.$executeRawUnsafe(
    `UPDATE "email_logs"
     SET
       "status" = 'FAILED',
       "updated_at" = $1,
       "failed_at" = $1,
       "locked_at" = NULL,
       "locked_until" = NULL,
       "locked_by" = NULL,
       "next_attempt_at" = NULL,
       "retry_count" = "retry_count" + 1,
       "error_message" = COALESCE("error_message", 'Email send lease expired and retry limit was exhausted')
     WHERE "status" = 'SENDING'
       AND (
         "locked_until" < $1
         OR (
           "locked_until" IS NULL
           AND COALESCE("locked_at", "last_attempt_at", "updated_at") < $2
         )
       )
       AND "retry_count" >= "max_retries"`,
    now,
    staleCutoff,
  );

  if (requeued > 0 || deadLettered > 0) {
    logger.warn({ requeued, deadLettered }, "Recovered stale email queue leases");
  }

  return { requeued, deadLettered };
}

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

  await recoverStaleEmailLeases(now, leaseMs);

  // Atomically claim a batch of due queued emails using FOR UPDATE SKIP LOCKED.
  // This prevents multiple server instances from grabbing the same rows and
  // records a lease owner so stale workers cannot write terminal outcomes.
  const claimedRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE "email_logs"
     SET
       "status" = 'SENDING',
       "updated_at" = $1,
       "locked_at" = $1,
       "locked_until" = $2,
       "locked_by" = $3,
       "last_attempt_at" = $1,
       "attempt_count" = "attempt_count" + 1,
       "error_message" = NULL
     WHERE "id" IN (
       SELECT "id" FROM "email_logs"
        WHERE "status" = 'QUEUED'
          AND ("next_attempt_at" IS NULL OR "next_attempt_at" <= $1)
          AND "attempt_count" <= "max_retries"
        ORDER BY "queued_at" ASC
        LIMIT $4
        FOR UPDATE SKIP LOCKED
     )
     RETURNING "id"`,
    now,
    lockedUntil,
    workerId,
    batchSize,
  );

  const claimedIds = claimedRows.map((row) => row.id);

  // Fetch full email log records with relations for processing
  const batch =
    claimedIds.length > 0
      ? await prisma.emailLog.findMany({
          where: { id: { in: claimedIds }, status: "SENDING", lockedBy: workerId },
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
        })
      : [];

  if (batch.length === 0) {
    return result;
  }

  result.processed = batch.length;

  // Process emails in parallel with controlled concurrency
  const CONCURRENCY_LIMIT = 10;

  // Image cache shared across the batch for certificate PDF generation.
  // Avoids re-downloading the same template image for each registrant.
  const imageCache: ImageCache = new Map();

  // Process a single email and return the outcome
  async function processEmail(
    emailLog: (typeof batch)[number],
  ): Promise<"sent" | "failed" | "skipped" | "lease-lost"> {
    try {
      // Skip if no template
      if (!emailLog.template) {
        return (await markAsSkipped(emailLog.id, workerId, "No template found"))
          ? "skipped"
          : "lease-lost";
      }

      // Skip if template is inactive
      if (!emailLog.template.isActive) {
        return (await markAsSkipped(emailLog.id, workerId, "Template is inactive"))
          ? "skipped"
          : "lease-lost";
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
        return (await markAsSkipped(
          emailLog.id,
          workerId,
          "Could not build email context",
        ))
          ? "skipped"
          : "lease-lost";
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

      // Update subject in log only if this worker still owns an active lease.
      const subjectUpdated = await prisma.emailLog.updateMany({
        where: {
          id: emailLog.id,
          status: "SENDING",
          lockedBy: workerId,
          lockedUntil: { gt: new Date() },
        },
        data: { subject: resolvedSubject },
      });

      if (subjectUpdated.count === 0) {
        logger.warn(
          { emailLogId: emailLog.id, workerId },
          "Email subject update skipped because lease was lost before send",
        );
        return "lease-lost";
      }

      // Generate certificate attachments if this is a CERTIFICATE_SENT email
      let attachments: EmailAttachment[] | undefined;

      const ctxAny = context as unknown as Record<string, unknown>;
      if (
        emailLog.trigger === "CERTIFICATE_SENT" &&
        Array.isArray(ctxAny._certificateTemplateIds) &&
        ctxAny._certificateTemplateIds.length > 0 &&
        emailLog.registrationId
      ) {
        const { generateCertificateAttachments } =
          await import("@modules/certificates/certificate-pdf.service.js");

        // Fetch registration with check-in data for eligibility + variable resolution
        const registration = await prisma.registration.findUnique({
          where: { id: emailLog.registrationId },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            role: true,
            checkedInAt: true,
            accessCheckIns: { select: { accessId: true } },
            event: { select: { name: true, startDate: true, location: true } },
          },
        });

        // Fetch the certificate templates
        const certTemplates = await prisma.certificateTemplate.findMany({
          where: { id: { in: ctxAny._certificateTemplateIds as string[] } },
          include: { access: { select: { id: true, name: true } } },
        });

        if (registration && certTemplates.length > 0) {
          attachments = await generateCertificateAttachments(
            registration,
            certTemplates.map((t) => ({
              ...t,
              zones: t.zones as CertificateZone[],
              applicableRoles: t.applicableRoles as string[],
              access: t.access,
            })),
            imageCache,
          );
        }

        const expectedCount = (ctxAny._certificateTemplateIds as string[])
          .length;
        if (!attachments || attachments.length === 0) {
          return (await markAsSkipped(
            emailLog.id,
            workerId,
            "No eligible certificates to attach",
          ))
            ? "skipped"
            : "lease-lost";
        }
        if (attachments.length < expectedCount) {
          logger.warn(
            {
              emailLogId: emailLog.id,
              expected: expectedCount,
              actual: attachments.length,
            },
            "Fewer certificates generated than queued — some templates may have been deactivated or check-in revoked",
          );
        }
      }

      if (!(await refreshEmailLeaseBeforeSend(emailLog.id, workerId, leaseMs))) {
        return "lease-lost";
      }

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
        attachments,
      });

      if (sendResult.success) {
        return (await markAsSent(emailLog.id, workerId, sendResult.messageId))
          ? "sent"
          : "lease-lost";
      } else {
        return (await markAsFailed(
          emailLog.id,
          workerId,
          sendResult.error || "Unknown error",
          emailLog.attemptCount,
          emailLog.maxRetries,
        ))
          ? "failed"
          : "lease-lost";
      }
    } catch (error: unknown) {
      const err = error as Error;
      logger.error(
        { emailLogId: emailLog.id, error: err.message },
        "Error processing email",
      );
      return (await markAsFailed(
        emailLog.id,
        workerId,
        err.message,
        emailLog.attemptCount,
        emailLog.maxRetries,
      ))
        ? "failed"
        : "lease-lost";
    }
  }

  // Process in chunks to limit concurrency
  for (let i = 0; i < batch.length; i += CONCURRENCY_LIMIT) {
    const chunk = batch.slice(i, i + CONCURRENCY_LIMIT);
    const outcomes = await Promise.all(chunk.map(processEmail));

    for (const outcome of outcomes) {
      if (outcome === "sent") result.sent++;
      else if (outcome === "failed") result.failed++;
      else if (outcome === "skipped") result.skipped++;
    }
  }

  return result;
}

// =============================================================================
// STATUS UPDATES
// =============================================================================

async function refreshEmailLeaseBeforeSend(
  id: string,
  workerId: string,
  leaseMs: number,
): Promise<boolean> {
  const now = new Date();
  const updated = await prisma.emailLog.updateMany({
    where: {
      id,
      status: "SENDING",
      lockedBy: workerId,
      lockedUntil: { gt: now },
    },
    data: {
      lockedAt: now,
      lockedUntil: new Date(now.getTime() + leaseMs),
    },
  });

  if (updated.count === 0) {
    logger.warn(
      { emailLogId: id, workerId },
      "Email send skipped because lease was lost before provider call",
    );
    return false;
  }

  return true;
}

async function markAsSent(
  id: string,
  workerId: string,
  messageId?: string,
): Promise<boolean> {
  const updated = await prisma.emailLog.updateMany({
    where: { id, status: "SENDING", lockedBy: workerId },
    data: {
      status: "SENT",
      sendgridMessageId: messageId,
      sentAt: new Date(),
      errorMessage: null,
      nextAttemptAt: null,
      ...clearEmailLeaseFields(),
    },
  });

  if (updated.count === 0) {
    logger.warn({ emailLogId: id, workerId }, "Email SENT update skipped because lease was lost");
    return false;
  }

  void emitEmailLogChanged(id, "SENT");
  return true;
}

async function markAsFailed(
  id: string,
  workerId: string,
  errorMessage: string,
  attemptCount: number,
  maxRetries: number,
): Promise<boolean> {
  const retryLimit = maxRetries ?? MAX_RETRIES;
  const shouldRetry = attemptCount <= retryLimit;
  const retryCountAfterFailure = Math.max(1, attemptCount);

  const updated = await prisma.emailLog.updateMany({
    where: { id, status: "SENDING", lockedBy: workerId },
    data: {
      status: shouldRetry ? "QUEUED" : "FAILED",
      errorMessage,
      retryCount: { increment: 1 },
      failedAt: shouldRetry ? null : new Date(),
      nextAttemptAt: shouldRetry
        ? nextEmailAttemptAt(retryCountAfterFailure)
        : null,
      ...clearEmailLeaseFields(),
    },
  });

  if (updated.count === 0) {
    logger.warn({ emailLogId: id, workerId }, "Email failure update skipped because lease was lost");
    return false;
  }

  void emitEmailLogChanged(id, shouldRetry ? "QUEUED" : "FAILED");
  return true;
}

async function markAsSkipped(
  id: string,
  workerId: string,
  reason: string,
): Promise<boolean> {
  const updated = await prisma.emailLog.updateMany({
    where: { id, status: "SENDING", lockedBy: workerId },
    data: {
      status: "SKIPPED",
      errorMessage: reason,
      nextAttemptAt: null,
      ...clearEmailLeaseFields(),
    },
  });

  if (updated.count === 0) {
    logger.warn({ emailLogId: id, workerId }, "Email SKIPPED update skipped because lease was lost");
    return false;
  }

  void emitEmailLogChanged(id, "SKIPPED");
  return true;
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
  event:
    | "delivered"
    | "open"
    | "click"
    | "bounce"
    | "dropped"
    | "blocked"
    | "spam_report"
    | "unsubscribe",
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
    // --- State machine guard: prevent backward / duplicate transitions ---
    const currentLog = await prisma.emailLog.findUnique({
      where: { id: emailLogId },
      select: { status: true },
    });

    if (!currentLog) {
      logger.warn(
        { emailLogId, event },
        "Webhook received for unknown email log — skipping",
      );
      return;
    }

    const currentStatus = currentLog.status;

    // Never overwrite a terminal status
    if (TERMINAL_STATUSES.has(currentStatus)) {
      logger.info(
        { emailLogId, event, currentStatus },
        "Webhook skipped — email already in terminal status",
      );
      return;
    }

    // For non-terminal new statuses, only allow forward transitions
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

    await prisma.emailLog.update({
      where: { id: emailLogId },
      data: updates,
    });
    if (updates.status) {
      void emitEmailLogChanged(emailLogId, updates.status);
    }
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

// =============================================================================
// QUEUE HEALTH
// =============================================================================

export async function getEmailQueueHealth() {
  const now = new Date();
  const [
    queueSize,
    dueQueuedCount,
    sendingCount,
    staleSendingCount,
    failedCount,
    recentFailures,
    oldestQueued,
    oldestInFlight,
  ] = await Promise.all([
    prisma.emailLog.count({ where: { status: "QUEUED" } }),
    prisma.emailLog.count({
      where: {
        status: "QUEUED",
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
    }),
    prisma.emailLog.count({ where: { status: "SENDING" } }),
    prisma.emailLog.count({
      where: {
        status: "SENDING",
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
    }),
    prisma.emailLog.count({ where: { status: "FAILED" } }),
    prisma.emailLog.count({
      where: {
        status: "FAILED",
        updatedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    }),
    prisma.emailLog.findFirst({
      where: { status: "QUEUED" },
      orderBy: { queuedAt: "asc" },
      select: { queuedAt: true },
    }),
    prisma.emailLog.findFirst({
      where: { status: "SENDING" },
      orderBy: { lockedAt: "asc" },
      select: { lockedAt: true, updatedAt: true },
    }),
  ]);

  const oldestQueuedAgeMs = oldestQueued?.queuedAt
    ? now.getTime() - oldestQueued.queuedAt.getTime()
    : 0;
  const oldestInFlightAt = oldestInFlight?.lockedAt ?? oldestInFlight?.updatedAt;
  const oldestInFlightAgeMs = oldestInFlightAt
    ? now.getTime() - oldestInFlightAt.getTime()
    : 0;

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
    oldestQueuedAgeMs,
    oldestInFlightAgeMs,
    recentFailures24h: recentFailures,
    isHealthy,
  };
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
