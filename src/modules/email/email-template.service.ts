// =============================================================================
// EMAIL TEMPLATE SERVICE
// CRUD operations for email templates
// =============================================================================

import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { paginate, getSkip } from "@shared/utils/pagination.js";
import {
  renderTemplateToMjml,
  compileMjmlToHtml,
  extractPlainText,
} from "./email-renderer.service.js";
import type { TiptapDocument } from "./email.types.js";
import type {
  Prisma,
  EmailTemplate,
  AutomaticEmailTrigger,
  AbstractEmailTrigger,
  EmailStatus,
} from "@/generated/prisma/client.js";
import type { ListEventEmailLogsQuery } from "./email.schema.js";

// =============================================================================
// Types
// =============================================================================

type EmailTemplateWithRelations = Prisma.EmailTemplateGetPayload<{
  include: { event: true };
}>;

type TemplateCategory = "AUTOMATIC" | "MANUAL";

interface TemplateTriggerState {
  category: TemplateCategory;
  trigger: AutomaticEmailTrigger | null;
  abstractTrigger: AbstractEmailTrigger | null;
}

function validateTemplateTriggerState({
  category,
  trigger,
  abstractTrigger,
}: TemplateTriggerState): void {
  if (category === "MANUAL") {
    if (trigger || abstractTrigger) {
      throw new AppError(
        "Manual templates should not have triggers",
        400,
        ErrorCodes.BAD_REQUEST,
      );
    }
    return;
  }

  if (Boolean(trigger) === Boolean(abstractTrigger)) {
    throw new AppError(
      "Automatic templates require exactly one trigger",
      400,
      ErrorCodes.BAD_REQUEST,
    );
  }
}

async function assertNoActiveTemplateForTrigger(input: {
  eventId: string | null;
  trigger: AutomaticEmailTrigger | null;
  abstractTrigger: AbstractEmailTrigger | null;
  excludeId?: string;
}): Promise<void> {
  if (!input.eventId || (!input.trigger && !input.abstractTrigger)) return;

  const duplicate = await prisma.emailTemplate.findFirst({
    where: {
      eventId: input.eventId,
      ...(input.trigger
        ? { trigger: input.trigger }
        : { abstractTrigger: input.abstractTrigger }),
      isActive: true,
      ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
    },
  });

  if (duplicate) {
    const trigger = input.trigger ?? input.abstractTrigger;
    throw new AppError(
      `An active template for trigger "${trigger}" already exists for this event`,
      409,
      ErrorCodes.CONFLICT,
    );
  }
}

// =============================================================================
// CREATE
// =============================================================================

export async function createEmailTemplate(input: {
  eventId: string;
  name: string;
  description?: string | null;
  subject: string;
  content: TiptapDocument;
  category: "AUTOMATIC" | "MANUAL";
  trigger?: AutomaticEmailTrigger | null;
  abstractTrigger?: AbstractEmailTrigger | null;
  isActive?: boolean;
}): Promise<EmailTemplate> {
  // Get the event to find clientId
  const event = await prisma.event.findUnique({
    where: { id: input.eventId },
    select: { clientId: true },
  });

  if (!event) {
    throw new AppError(
      "Event not found",
      404, ErrorCodes.NOT_FOUND);
  }

  const triggerState: TemplateTriggerState = {
    category: input.category,
    trigger: input.trigger ?? null,
    abstractTrigger: input.abstractTrigger ?? null,
  };
  validateTemplateTriggerState(triggerState);
  await assertNoActiveTemplateForTrigger({
    eventId: input.eventId,
    trigger: triggerState.trigger,
    abstractTrigger: triggerState.abstractTrigger,
  });

  // Pre-compile the template (Tiptap -> MJML -> HTML + plain text)
  const mjmlContent = renderTemplateToMjml(input.content);
  const { html: htmlContent } = compileMjmlToHtml(mjmlContent);
  const plainContent = extractPlainText(input.content);

  return prisma.emailTemplate.create({
    data: {
      clientId: event.clientId,
      eventId: input.eventId,
      name: input.name,
      description: input.description ?? null,
      subject: input.subject,
      content: input.content as unknown as Prisma.InputJsonValue,
      mjmlContent,
      htmlContent,
      plainContent,
      category: triggerState.category,
      trigger: triggerState.trigger,
      abstractTrigger: triggerState.abstractTrigger,
      isActive: input.isActive ?? true,
    },
  });
}

// =============================================================================
// READ
// =============================================================================

export async function getEmailTemplateById(
  id: string,
): Promise<EmailTemplate | null> {
  return prisma.emailTemplate.findUnique({
    where: { id },
  });
}

export async function getEmailTemplateWithEvent(
  id: string,
): Promise<EmailTemplateWithRelations | null> {
  return prisma.emailTemplate.findFirst({
    where: { id },
    include: { event: true },
  });
}

// Get clientId for permission checks
export async function getEmailTemplateClientId(
  id: string,
): Promise<string | null> {
  const template = await prisma.emailTemplate.findUnique({
    where: { id },
    select: { clientId: true },
  });
  return template?.clientId ?? null;
}

// =============================================================================
// LIST
// =============================================================================

export async function listEmailTemplates(
  eventId: string,
  query: {
    page?: number;
    limit?: number;
    category?: "AUTOMATIC" | "MANUAL";
    trigger?: AutomaticEmailTrigger;
    abstractTrigger?: AbstractEmailTrigger;
    search?: string;
  },
) {
  const {
    page = 1,
    limit = 20,
    category,
    trigger,
    abstractTrigger,
    search,
  } = query;
  const skip = getSkip({ page, limit });

  const where: Prisma.EmailTemplateWhereInput = {
    eventId,
    ...(category && { category }),
    ...(trigger && { trigger }),
    ...(abstractTrigger && { abstractTrigger }),
    ...(search && {
      OR: [
        { name: { contains: search, mode: "insensitive" } },
        { subject: { contains: search, mode: "insensitive" } },
      ],
    }),
  };

  const [data, total] = await Promise.all([
    prisma.emailTemplate.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
    prisma.emailTemplate.count({ where }),
  ]);

  return paginate(data, total, { page, limit });
}

// Get template by trigger (for automatic emails)
export async function getTemplateByTrigger(
  eventId: string,
  trigger: AutomaticEmailTrigger,
): Promise<EmailTemplate | null> {
  return prisma.emailTemplate.findFirst({
    where: {
      eventId,
      trigger,
      category: "AUTOMATIC",
      isActive: true,
    },
  });
}

// =============================================================================
// UPDATE
// =============================================================================

export async function updateEmailTemplate(
  id: string,
  input: {
    name?: string;
    description?: string | null;
    subject?: string;
    content?: TiptapDocument;
    category?: "AUTOMATIC" | "MANUAL";
    trigger?: AutomaticEmailTrigger | null;
    abstractTrigger?: AbstractEmailTrigger | null;
    isActive?: boolean;
  },
): Promise<EmailTemplate> {
  const existing = await prisma.emailTemplate.findUnique({ where: { id } });

  if (!existing) {
    throw new AppError(
      "Email template not found",
      404,
      ErrorCodes.NOT_FOUND,
    );
  }

  const finalCategory = input.category ?? existing.category;
  const finalTrigger =
    input.trigger !== undefined ? input.trigger : existing.trigger;
  const finalAbstractTrigger =
    input.abstractTrigger !== undefined
      ? input.abstractTrigger
      : existing.abstractTrigger;

  const triggerState: TemplateTriggerState =
    finalCategory === "MANUAL"
      ? { category: finalCategory, trigger: null, abstractTrigger: null }
      : {
          category: finalCategory,
          trigger: finalTrigger,
          abstractTrigger: finalAbstractTrigger,
        };
  validateTemplateTriggerState(triggerState);

  const triggerChanged =
    triggerState.trigger !== existing.trigger ||
    triggerState.abstractTrigger !== existing.abstractTrigger ||
    triggerState.category !== existing.category;
  if (triggerState.category === "AUTOMATIC" && triggerChanged) {
    await assertNoActiveTemplateForTrigger({
      eventId: existing.eventId,
      trigger: triggerState.trigger,
      abstractTrigger: triggerState.abstractTrigger,
      excludeId: id,
    });
  }

  // If content is updated, re-compile
  let compiledContent: {
    mjmlContent?: string;
    htmlContent?: string;
    plainContent?: string;
  } = {};

  if (input.content) {
    const mjmlContent = renderTemplateToMjml(input.content);
    const { html: htmlContent } = compileMjmlToHtml(mjmlContent);
    const plainContent = extractPlainText(input.content);
    compiledContent = { mjmlContent, htmlContent, plainContent };
  }

  return prisma.emailTemplate.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && {
        description: input.description,
      }),
      ...(input.subject !== undefined && { subject: input.subject }),
      ...(input.content && {
        content: input.content as unknown as Prisma.InputJsonValue,
      }),
      ...compiledContent,
      ...(input.category !== undefined && { category: input.category }),
      ...(input.category !== undefined ||
      input.trigger !== undefined ||
      input.abstractTrigger !== undefined
        ? {
            trigger: triggerState.trigger,
            abstractTrigger: triggerState.abstractTrigger,
          }
        : {}),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
    },
  });
}

// =============================================================================
// DELETE
// =============================================================================

export async function deleteEmailTemplate(id: string): Promise<void> {
  const existing = await prisma.emailTemplate.findUnique({
    where: { id },
  });

  if (!existing) {
    throw new AppError(
      "Email template not found",
      404,
      ErrorCodes.NOT_FOUND,
    );
  }

  await prisma.emailTemplate.delete({ where: { id } });
}

// =============================================================================
// DUPLICATE
// =============================================================================

export async function duplicateEmailTemplate(
  id: string,
  newName?: string,
): Promise<EmailTemplate> {
  const existing = await prisma.emailTemplate.findUnique({ where: { id } });

  if (!existing) {
    throw new AppError(
      "Email template not found",
      404,
      ErrorCodes.NOT_FOUND,
    );
  }

  return prisma.emailTemplate.create({
    data: {
      clientId: existing.clientId,
      eventId: existing.eventId,
      name: newName || `${existing.name} (Copy)`,
      description: existing.description,
      subject: existing.subject,
      content: existing.content as Prisma.InputJsonValue,
      mjmlContent: existing.mjmlContent,
      htmlContent: existing.htmlContent,
      plainContent: existing.plainContent,
      category: "MANUAL", // Duplicates are always manual
      trigger: null,
      abstractTrigger: null,
      isActive: false, // Start as inactive
    },
  });
}

// =============================================================================
// LIST EVENT EMAIL LOGS
// =============================================================================

export interface EventEmailLog {
  id: string;
  subject: string;
  status: string;
  trigger: string | null;
  templateName: string | null;
  recipientEmail: string;
  recipientName: string | null;
  errorMessage: string | null;
  queuedAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  bouncedAt: string | null;
  failedAt: string | null;
}

export async function listEventEmailLogs(
  eventId: string,
  query: ListEventEmailLogsQuery,
) {
  const { page, limit, status, trigger } = query;
  const skip = getSkip({ page, limit });

  // EmailLog has no direct eventId. Query via registration.eventId OR template.eventId.
  const where: Prisma.EmailLogWhereInput = {
    OR: [
      { registration: { eventId } },
      { template: { eventId } },
    ],
    ...(status && { status: status as EmailStatus }),
    ...(trigger && { trigger: trigger as AutomaticEmailTrigger }),
  };

  const [logs, total] = await Promise.all([
    prisma.emailLog.findMany({
      where,
      skip,
      take: limit,
      include: {
        template: { select: { name: true } },
      },
      orderBy: { queuedAt: "desc" },
    }),
    prisma.emailLog.count({ where }),
  ]);

  const data: EventEmailLog[] = logs.map((log) => ({
    id: log.id,
    subject: log.subject,
    status: log.status,
    trigger: log.trigger,
    templateName: log.template?.name ?? null,
    recipientEmail: log.recipientEmail,
    recipientName: log.recipientName,
    errorMessage: log.errorMessage,
    queuedAt: log.queuedAt.toISOString(),
    sentAt: log.sentAt?.toISOString() ?? null,
    deliveredAt: log.deliveredAt?.toISOString() ?? null,
    openedAt: log.openedAt?.toISOString() ?? null,
    clickedAt: log.clickedAt?.toISOString() ?? null,
    bouncedAt: log.bouncedAt?.toISOString() ?? null,
    failedAt: log.failedAt?.toISOString() ?? null,
  }));

  return paginate(data, total, { page, limit });
}
