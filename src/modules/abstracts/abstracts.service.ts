import { prisma } from "@/database/client.js";
import { Prisma } from "@/generated/prisma/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { auditLog } from "@shared/utils/audit.js";
import { assertClientModuleEnabled } from "@clients";
import { validateFormData, sanitizeFormData, type FormSchema } from "@forms";
import { generateAbstractToken, verifyAbstractToken } from "./abstract-token.js";
import { queueAbstractEmail } from "./abstracts.email-queue.js";
import type {
  AbstractConfig,
  AbstractStatus,
} from "@/generated/prisma/client.js";

// ============================================================================
// Word count helper
// ============================================================================

export function countWords(s: string): number {
  if (!s) return 0;
  // Normalize unicode whitespace, split on whitespace, filter empties
  return s
    .replace(/[\u00A0\u2000-\u200B\u3000]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

// ============================================================================
// Types
// ============================================================================

interface SubmitAbstractInput {
  authorFirstName: string;
  authorLastName: string;
  authorEmail: string;
  authorPhone: string;
  coAuthors: { firstName: string; lastName: string; affiliation?: string }[];
  requestedType: "ORAL_COMMUNICATION" | "POSTER";
  themeIds: string[];
  content:
    | { mode: "FREE_TEXT"; title: string; body: string }
    | {
        mode: "STRUCTURED";
        title: string;
        introduction: string;
        objective: string;
        methods: string;
        results: string;
        conclusion: string;
      };
  additionalFieldsData: Record<string, unknown>;
  registrationId?: string | null;
  linkBaseUrl: string;
}

function buildRevisionSnapshot(
  body: SubmitAbstractInput,
  additionalFieldsData: Record<string, unknown>,
  registrationId: string | null,
  themeIds: string[],
): Prisma.InputJsonObject {
  return {
    authorFirstName: body.authorFirstName,
    authorLastName: body.authorLastName,
    authorEmail: body.authorEmail,
    authorPhone: body.authorPhone,
    coAuthors: body.coAuthors as unknown as Prisma.InputJsonValue,
    content: body.content as unknown as Prisma.InputJsonValue,
    additionalFieldsData: additionalFieldsData as Prisma.InputJsonValue,
    requestedType: body.requestedType,
    themeIds,
    registrationId,
  };
}

// ============================================================================
// Validation helpers
// ============================================================================

function validateMode(
  contentMode: string,
  configMode: string,
): void {
  if (contentMode !== configMode) {
    throw new AppError(
      `Submission mode mismatch: expected ${configMode}, got ${contentMode}`,
      409,
      ErrorCodes.ABSTRACT_MODE_MISMATCH,
    );
  }
}

function validateWordLimits(
  content: SubmitAbstractInput["content"],
  config: AbstractConfig,
): void {
  const errors: string[] = [];

  if (content.mode === "FREE_TEXT") {
    if (config.globalWordLimit && countWords(content.body) > config.globalWordLimit) {
      errors.push(`body (${countWords(content.body)} words, limit ${config.globalWordLimit})`);
    }
  } else {
    const sectionLimits = (config.sectionWordLimits as Record<string, number> | null) ?? {};
    const sections = ["introduction", "objective", "methods", "results", "conclusion"] as const;
    for (const section of sections) {
      const limit = sectionLimits[section];
      const text = (content as Record<string, string>)[section] ?? "";
      if (limit && countWords(text) > limit) {
        errors.push(`${section} (${countWords(text)} words, limit ${limit})`);
      }
    }
    // Also check global limit against total
    if (config.globalWordLimit) {
      const total = sections.reduce(
        (acc, s) => acc + countWords((content as Record<string, string>)[s] ?? ""),
        0,
      );
      if (total > config.globalWordLimit) {
        errors.push(`total (${total} words, limit ${config.globalWordLimit})`);
      }
    }
  }

  if (errors.length > 0) {
    throw new AppError(
      `Word limit exceeded: ${errors.join(", ")}`,
      422,
      ErrorCodes.ABSTRACT_WORD_LIMIT_EXCEEDED,
      { fields: errors },
    );
  }
}

async function validateThemes(
  themeIds: string[],
  configId: string,
): Promise<void> {
  if (themeIds.length === 0) {
    throw new AppError(
      "At least one theme is required",
      422,
      ErrorCodes.ABSTRACT_INVALID_THEMES,
    );
  }

  const themes = await prisma.abstractTheme.findMany({
    where: {
      id: { in: themeIds },
      configId,
      active: true,
    },
    select: { id: true },
  });

  if (themes.length !== themeIds.length) {
    const foundIds = new Set(themes.map((t) => t.id));
    const invalid = themeIds.filter((id) => !foundIds.has(id));
    throw new AppError(
      `Invalid or inactive theme IDs: ${invalid.join(", ")}`,
      422,
      ErrorCodes.ABSTRACT_INVALID_THEMES,
      { invalidThemeIds: invalid },
    );
  }
}

function validateAdditionalFields(
  data: Record<string, unknown>,
  schemaFields: unknown,
): Record<string, unknown> {
  // schemaFields is the raw JSON array of FormField objects from AbstractConfig
  const fields = Array.isArray(schemaFields) ? schemaFields : [];
  if (fields.length === 0) {
    return {};
  }

  // Wrap into the FormSchema shape expected by the validator
  const formSchema: FormSchema = {
    steps: [{ id: "additional", title: "Additional", fields }],
  };

  const result = validateFormData(formSchema, data);
  if (!result.valid) {
    throw new AppError(
      "Additional fields validation failed",
      422,
      ErrorCodes.ABSTRACT_ADDITIONAL_FIELDS_INVALID,
      { fieldErrors: result.errors },
    );
  }

  return sanitizeFormData(formSchema, data);
}

// ============================================================================
// Public config
// ============================================================================

export async function getPublicConfig(slug: string) {
  const event = await prisma.event.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      clientId: true,
      abstractConfig: {
        include: {
          themes: {
            where: { active: true },
            orderBy: { sortOrder: "asc" },
            select: { id: true, label: true },
          },
        },
      },
    },
  });

  if (!event) {
    throw new AppError("Event not found", 404, ErrorCodes.NOT_FOUND);
  }

  await assertClientModuleEnabled(event.clientId, "abstracts");

  const config = event.abstractConfig;
  if (!config) {
    return { enabled: false } as const;
  }

  const now = new Date();
  const submissionOpen = !config.submissionDeadline || now <= config.submissionDeadline;

  const sectionLimits = (config.sectionWordLimits ?? {}) as Record<string, number | null>;

  return {
    enabled: true,
    acceptingSubmissions: submissionOpen,
    eventId: event.id,
    eventName: event.name,
    congressName: event.name,
    submissionMode: config.submissionMode,
    globalWordLimit: config.globalWordLimit,
    sectionWordLimits: {
      introduction: sectionLimits.introduction ?? null,
      objective: sectionLimits.objective ?? null,
      methods: sectionLimits.methods ?? null,
      results: sectionLimits.results ?? null,
      conclusion: sectionLimits.conclusion ?? null,
    },
    themes: config.themes,
    additionalFields: {
      fields: Array.isArray(config.additionalFieldsSchema)
        ? config.additionalFieldsSchema
        : [],
    },
    deadlines: {
      submission: config.submissionDeadline?.toISOString() ?? null,
      editing: config.editingDeadline?.toISOString() ?? null,
      finalFile: config.finalFileDeadline?.toISOString() ?? null,
    },
    editingEnabled: config.editingEnabled,
    finalFileUploadEnabled: config.finalFileUploadEnabled,
  };
}

// ============================================================================
// Submit abstract
// ============================================================================

export async function submitAbstract(
  slug: string,
  body: SubmitAbstractInput,
  ip?: string,
) {
  const event = await prisma.event.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      slug: true,
      clientId: true,
      abstractConfig: {
        select: {
          id: true,
          submissionMode: true,
          globalWordLimit: true,
          sectionWordLimits: true,
          submissionDeadline: true,
          editingDeadline: true,
          editingEnabled: true,
          finalFileUploadEnabled: true,
          finalFileDeadline: true,
          additionalFieldsSchema: true,
        },
      },
    },
  });

  if (!event) {
    throw new AppError("Event not found", 404, ErrorCodes.NOT_FOUND);
  }

  await assertClientModuleEnabled(event.clientId, "abstracts");

  const config = event.abstractConfig;
  if (!config) {
    throw new AppError("Abstract submissions not configured", 404, ErrorCodes.NOT_FOUND);
  }

  // Deadline check
  const now = new Date();
  if (config.submissionDeadline && now > config.submissionDeadline) {
    throw new AppError(
      "Abstract submissions are closed",
      409,
      ErrorCodes.ABSTRACT_SUBMISSIONS_CLOSED,
    );
  }

  // Mode check
  validateMode(body.content.mode, config.submissionMode);

  // Word limit check
  validateWordLimits(body.content, config as unknown as AbstractConfig);

  // Theme validation
  await validateThemes(body.themeIds, config.id);

  // Additional fields validation
  const sanitizedAdditionalFields = validateAdditionalFields(
    body.additionalFieldsData,
    config.additionalFieldsSchema,
  );

  const editToken = generateAbstractToken();

  // Transaction: create abstract + first revision + theme links
  const created = await prisma.$transaction(async (tx) => {
    const abstract = await tx.abstract.create({
      data: {
        eventId: event.id,
        authorFirstName: body.authorFirstName,
        authorLastName: body.authorLastName,
        authorEmail: body.authorEmail,
        authorPhone: body.authorPhone,
        requestedType: body.requestedType,
        content: body.content as unknown as Prisma.InputJsonValue,
        coAuthors: body.coAuthors as unknown as Prisma.InputJsonValue,
        additionalFieldsData: sanitizedAdditionalFields as unknown as Prisma.InputJsonValue,
        status: "SUBMITTED",
        editToken,
        linkBaseUrl: body.linkBaseUrl,
        registrationId: body.registrationId ?? null,
      },
    });

    const revisionSnapshot = buildRevisionSnapshot(
      body,
      sanitizedAdditionalFields,
      body.registrationId ?? null,
      body.themeIds,
    );

    // Create initial revision
    await tx.abstractRevision.create({
      data: {
        abstractId: abstract.id,
        revisionNo: 1,
        snapshot: revisionSnapshot,
        editedBy: "PUBLIC",
        editedIpAddress: ip,
        content: body.content as unknown as Prisma.InputJsonValue,
        coAuthors: body.coAuthors as unknown as Prisma.InputJsonValue,
        additionalFieldsData: sanitizedAdditionalFields as unknown as Prisma.InputJsonValue,
      },
    });

    // Link themes
    if (body.themeIds.length > 0) {
      await tx.abstractThemeOnAbstract.createMany({
        data: body.themeIds.map((themeId) => ({
          abstractId: abstract.id,
          themeId,
        })),
      });
    }

    // Audit log
    await auditLog(tx, {
      entityType: "Abstract",
      entityId: abstract.id,
      action: "submit",
      performedBy: "PUBLIC",
      ipAddress: ip,
    });

    return abstract;
  });

  // Queue email after transaction
  void queueAbstractEmail({
    trigger: "ABSTRACT_SUBMISSION_ACK",
    abstractId: created.id,
  });

  const statusUrl = `${body.linkBaseUrl}/${slug}/abstracts/${created.id}/${editToken}`;

  return {
    id: created.id,
    token: editToken,
    status: "SUBMITTED" as const,
    createdAt: created.createdAt.toISOString(),
    statusUrl,
  };
}

// ============================================================================
// Get abstract by token
// ============================================================================

export async function getAbstractByToken(id: string, token: string) {
  const abstract = await prisma.abstract.findUnique({
    where: { id },
    include: {
      themes: {
        include: {
          theme: { select: { id: true, label: true } },
        },
      },
      event: {
        select: {
          abstractConfig: {
            select: {
              editingEnabled: true,
              editingDeadline: true,
              finalFileUploadEnabled: true,
              finalFileDeadline: true,
            },
          },
        },
      },
    },
  });

  if (!abstract) {
    throw new AppError("Abstract not found", 404, ErrorCodes.NOT_FOUND);
  }

  if (!verifyAbstractToken(abstract.editToken, token)) {
    throw new AppError("Invalid abstract token", 404, ErrorCodes.NOT_FOUND);
  }

  const config = abstract.event.abstractConfig;
  const now = new Date();
  const editingAllowed =
    !!config?.editingEnabled &&
    (!config.editingDeadline || now <= config.editingDeadline);

  return {
    id: abstract.id,
    status: abstract.status,
    code: abstract.code,
    authorFirstName: abstract.authorFirstName,
    authorLastName: abstract.authorLastName,
    authorEmail: abstract.authorEmail,
    authorPhone: abstract.authorPhone,
    coAuthors: abstract.coAuthors,
    requestedType: abstract.requestedType,
    finalType: abstract.finalType,
    themes: abstract.themes.map((t) => t.theme),
    content: abstract.content,
    additionalFieldsData: abstract.additionalFieldsData,
    createdAt: abstract.createdAt.toISOString(),
    updatedAt: abstract.updatedAt.toISOString(),
    lastEditedAt: abstract.lastEditedAt?.toISOString() ?? null,
    editing: {
      allowed: editingAllowed,
      deadline: config?.editingDeadline?.toISOString() ?? null,
    },
    finalFile: {
      enabled: config?.finalFileUploadEnabled ?? false,
      deadline: config?.finalFileDeadline?.toISOString() ?? null,
      kind: abstract.finalFileKind,
      size: abstract.finalFileSize,
      uploadedAt: abstract.finalFileUploadedAt?.toISOString() ?? null,
      uploaded: !!abstract.finalFileKey,
    },
  };
}

// ============================================================================
// Edit abstract
// ============================================================================

const NON_EDITABLE_STATUSES: AbstractStatus[] = ["ACCEPTED", "REJECTED"];

export async function editAbstract(
  id: string,
  token: string,
  body: SubmitAbstractInput,
  ip?: string,
) {
  const abstract = await prisma.abstract.findUnique({
    where: { id },
    include: {
      event: {
        select: {
          id: true,
          name: true,
          slug: true,
          clientId: true,
          abstractConfig: {
            select: {
              id: true,
              submissionMode: true,
              globalWordLimit: true,
              sectionWordLimits: true,
              editingEnabled: true,
              editingDeadline: true,
              additionalFieldsSchema: true,
            },
          },
        },
      },
    },
  });

  if (!abstract) {
    throw new AppError("Abstract not found", 404, ErrorCodes.NOT_FOUND);
  }

  if (!verifyAbstractToken(abstract.editToken, token)) {
    throw new AppError("Invalid abstract token", 404, ErrorCodes.NOT_FOUND);
  }

  const config = abstract.event.abstractConfig;
  if (!config) {
    throw new AppError("Abstract config not found", 404, ErrorCodes.NOT_FOUND);
  }

  // Editing disabled check
  if (!config.editingEnabled) {
    throw new AppError(
      "Abstract editing is disabled",
      409,
      ErrorCodes.ABSTRACT_EDIT_DISABLED,
    );
  }

  // Editing deadline check
  const now = new Date();
  if (config.editingDeadline && now > config.editingDeadline) {
    throw new AppError(
      "Editing deadline has passed",
      409,
      ErrorCodes.ABSTRACT_EDIT_DEADLINE_PASSED,
    );
  }

  // Status check
  if (NON_EDITABLE_STATUSES.includes(abstract.status)) {
    throw new AppError(
      `Abstract cannot be edited in ${abstract.status} status`,
      409,
      ErrorCodes.ABSTRACT_NOT_EDITABLE,
    );
  }

  // Re-validate everything
  validateMode(body.content.mode, config.submissionMode);
  validateWordLimits(body.content, config as unknown as AbstractConfig);
  await validateThemes(body.themeIds, config.id);
  const sanitizedAdditionalFields = validateAdditionalFields(
    body.additionalFieldsData,
    config.additionalFieldsSchema,
  );

  const nextRegistrationId = body.registrationId ?? abstract.registrationId;
  const revisionSnapshot = buildRevisionSnapshot(
    body,
    sanitizedAdditionalFields,
    nextRegistrationId,
    body.themeIds,
  );

  // Transaction: update + new revision + theme links
  await prisma.$transaction(async (tx) => {
    // Get next revision number
    const lastRevision = await tx.abstractRevision.findFirst({
      where: { abstractId: id },
      orderBy: { revisionNo: "desc" },
      select: { revisionNo: true },
    });
    const nextRevisionNo = (lastRevision?.revisionNo ?? 0) + 1;

    // Update abstract
    const updatedAbstract = await tx.abstract.update({
      where: { id },
      data: {
        authorFirstName: body.authorFirstName,
        authorLastName: body.authorLastName,
        authorEmail: body.authorEmail,
        authorPhone: body.authorPhone,
        requestedType: body.requestedType,
        content: body.content as unknown as Prisma.InputJsonValue,
        coAuthors: body.coAuthors as unknown as Prisma.InputJsonValue,
        additionalFieldsData: sanitizedAdditionalFields as unknown as Prisma.InputJsonValue,
        registrationId: nextRegistrationId,
        lastEditedAt: now,
        contentVersion: { increment: 1 },
      },
    });

    // Append new revision
    await tx.abstractRevision.create({
      data: {
        abstractId: id,
        revisionNo: nextRevisionNo,
        snapshot: revisionSnapshot,
        editedBy: "PUBLIC",
        editedIpAddress: ip,
        content: body.content as unknown as Prisma.InputJsonValue,
        coAuthors: body.coAuthors as unknown as Prisma.InputJsonValue,
        additionalFieldsData: sanitizedAdditionalFields as unknown as Prisma.InputJsonValue,
      },
    });

    // Replace theme links
    await tx.abstractThemeOnAbstract.deleteMany({
      where: { abstractId: id },
    });
    if (body.themeIds.length > 0) {
      await tx.abstractThemeOnAbstract.createMany({
        data: body.themeIds.map((themeId) => ({
          abstractId: id,
          themeId,
        })),
      });
    }

    // Audit log
    await auditLog(tx, {
      entityType: "Abstract",
      entityId: id,
      action: "edit",
      performedBy: "PUBLIC",
      ipAddress: ip,
    });

    return updatedAbstract;
  });

  // Queue email after transaction
  void queueAbstractEmail({
    trigger: "ABSTRACT_EDIT_ACK",
    abstractId: id,
  });

  // Return the same shape as getAbstractByToken
  return getAbstractByToken(id, token);
}
