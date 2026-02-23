// =============================================================================
// EMAIL TEMPLATE SERVICE
// CRUD operations for email templates
// =============================================================================

import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors.js";
import { ErrorCodes } from "@shared/errors.js";
import { paginate, getSkip } from "@shared/utils/pagination.js";
import {
  renderTemplateToMjml,
  compileMjmlToHtml,
  extractPlainText,
} from "./email-renderer.service.js";
import { getQueuedEmailCountForTemplate } from "./email-queue.service.js";
import type { TiptapDocument } from "./email.schema.js";
import type {
  Prisma,
  EmailTemplate,
  AutomaticEmailTrigger,
} from "@/generated/prisma/client.js";

// =============================================================================
// Types
// =============================================================================

type EmailTemplateWithRelations = Prisma.EmailTemplateGetPayload<{
  include: { event: true };
}>;

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
  isActive?: boolean;
}): Promise<EmailTemplate> {
  // Get the event to find clientId
  const event = await prisma.event.findUnique({
    where: { id: input.eventId },
    select: { clientId: true },
  });

  if (!event) {
    throw new AppError("Event not found", 404, true, ErrorCodes.NOT_FOUND);
  }

  // For automatic templates, check uniqueness per event+trigger
  if (input.category === "AUTOMATIC" && input.trigger) {
    const existing = await prisma.emailTemplate.findFirst({
      where: {
        eventId: input.eventId,
        trigger: input.trigger,
        isActive: true,
      },
    });
    if (existing) {
      throw new AppError(
        `An active template for trigger "${input.trigger}" already exists for this event`,
        409,
        true,
        ErrorCodes.CONFLICT,
      );
    }
  }

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
      category: input.category,
      trigger: input.trigger ?? null,
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
  return prisma.emailTemplate.findUnique({
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
    search?: string;
  },
) {
  const { page = 1, limit = 20, category, search } = query;
  const skip = getSkip({ page, limit });

  const where: Prisma.EmailTemplateWhereInput = {
    eventId,
    ...(category && { category }),
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
    isActive?: boolean;
  },
): Promise<EmailTemplate> {
  const existing = await prisma.emailTemplate.findUnique({ where: { id } });

  if (!existing) {
    throw new AppError(
      "Email template not found",
      404,
      true,
      ErrorCodes.NOT_FOUND,
    );
  }

  // Determine final category and trigger values
  const finalCategory = input.category ?? existing.category;
  const finalTrigger =
    input.trigger !== undefined ? input.trigger : existing.trigger;

  // Validate category/trigger consistency
  if (finalCategory === "AUTOMATIC" && !finalTrigger) {
    throw new AppError(
      "Automatic templates require a trigger",
      400,
      true,
      ErrorCodes.BAD_REQUEST,
    );
  }
  if (finalCategory === "MANUAL" && finalTrigger) {
    throw new AppError(
      "Manual templates should not have a trigger",
      400,
      true,
      ErrorCodes.BAD_REQUEST,
    );
  }

  // Check for duplicate trigger if changing to automatic or changing trigger
  if (
    finalCategory === "AUTOMATIC" &&
    finalTrigger &&
    (finalTrigger !== existing.trigger || finalCategory !== existing.category)
  ) {
    const duplicate = await prisma.emailTemplate.findFirst({
      where: {
        eventId: existing.eventId,
        trigger: finalTrigger,
        isActive: true,
        id: { not: id }, // Exclude current template
      },
    });
    if (duplicate) {
      throw new AppError(
        `An active template for trigger "${finalTrigger}" already exists for this event`,
        409,
        true,
        ErrorCodes.CONFLICT,
      );
    }
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
      ...(input.trigger !== undefined && { trigger: input.trigger }),
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
      true,
      ErrorCodes.NOT_FOUND,
    );
  }

  const queuedCount = await getQueuedEmailCountForTemplate(id);
  if (queuedCount > 0) {
    throw new AppError(
      `Cannot delete template: ${queuedCount} email(s) are queued or sending`,
      409,
      true,
      ErrorCodes.TEMPLATE_HAS_QUEUED_EMAILS,
      { queuedCount },
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
      true,
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
      isActive: false, // Start as inactive
    },
  });
}
