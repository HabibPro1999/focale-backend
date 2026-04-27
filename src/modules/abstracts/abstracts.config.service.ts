import { prisma } from "@/database/client.js";
import { Prisma, type AbstractConfig, type AbstractTheme } from "@/generated/prisma/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { auditLog } from "@shared/utils/audit.js";
import type {
  PatchConfigInput,
  CreateThemeInput,
  UpdateThemeInput,
  AdditionalFieldsInput,
} from "./abstracts.schema.js";

// ============================================================================
// Config
// ============================================================================

export async function getOrCreateConfig(
  eventId: string,
): Promise<AbstractConfig> {
  const existing = await prisma.abstractConfig.findUnique({
    where: { eventId },
  });
  if (existing) return existing;

  return prisma.abstractConfig.create({
    data: { eventId },
  });
}

export async function updateConfig(
  eventId: string,
  patch: PatchConfigInput,
  performedBy: string,
): Promise<AbstractConfig> {
  const config = await getOrCreateConfig(eventId);
  const { force, ...fields } = patch;

  // Mode-lock check
  if (
    fields.submissionMode !== undefined &&
    fields.submissionMode !== config.submissionMode
  ) {
    const { forced } = await assertModeChangeAllowed(eventId, force ?? false);

    if (forced) {
      await auditLog(prisma, {
        entityType: "AbstractConfig",
        entityId: config.id,
        action: "mode_force_changed",
        changes: {
          submissionMode: {
            old: config.submissionMode,
            new: fields.submissionMode,
          },
        },
        performedBy,
      });
    }
  }

  // Build update data
  const data: Prisma.AbstractConfigUpdateInput = {};

  if (fields.submissionMode !== undefined)
    data.submissionMode = fields.submissionMode;
  if (fields.globalWordLimit !== undefined)
    data.globalWordLimit = fields.globalWordLimit;
  if (fields.sectionWordLimits !== undefined)
    data.sectionWordLimits =
      fields.sectionWordLimits as Prisma.InputJsonValue;
  if (fields.editingEnabled !== undefined)
    data.editingEnabled = fields.editingEnabled;
  if (fields.commentsEnabled !== undefined)
    data.commentsEnabled = fields.commentsEnabled;
  if (fields.commentsSentToAuthor !== undefined)
    data.commentsSentToAuthor = fields.commentsSentToAuthor;
  if (fields.finalFileUploadEnabled !== undefined)
    data.finalFileUploadEnabled = fields.finalFileUploadEnabled;
  if (fields.reviewersPerAbstract !== undefined)
    data.reviewersPerAbstract = fields.reviewersPerAbstract;
  if (fields.divergenceThreshold !== undefined)
    data.divergenceThreshold = fields.divergenceThreshold;
  if (fields.distributeByTheme !== undefined)
    data.distributeByTheme = fields.distributeByTheme;
  if (fields.bookFontFamily !== undefined)
    data.bookFontFamily = fields.bookFontFamily;
  if (fields.bookFontSize !== undefined)
    data.bookFontSize = fields.bookFontSize;
  if (fields.bookLineSpacing !== undefined)
    data.bookLineSpacing = fields.bookLineSpacing;
  if (fields.bookOrder !== undefined) data.bookOrder = fields.bookOrder;
  if (fields.bookIncludeAuthorNames !== undefined)
    data.bookIncludeAuthorNames = fields.bookIncludeAuthorNames;

  // Deadlines: accept ISO string or null → Date | null
  for (const key of [
    "submissionDeadline",
    "editingDeadline",
    "scoringDeadline",
    "finalFileDeadline",
  ] as const) {
    if (fields[key] !== undefined) {
      (data as Record<string, unknown>)[key] =
        fields[key] === null ? null : new Date(fields[key] as string);
    }
  }

  const updated = await prisma.abstractConfig.update({
    where: { id: config.id },
    data,
  });

  // Build a diff of changed fields for the audit log
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) {
      changes[k] = {
        old: (config as Record<string, unknown>)[k],
        new: (updated as Record<string, unknown>)[k],
      };
    }
  }

  await auditLog(prisma, {
    entityType: "AbstractConfig",
    entityId: config.id,
    action: "UPDATE",
    changes,
    performedBy,
  });

  return updated;
}

/**
 * Check whether changing submissionMode is allowed.
 * The abstracts table may not exist yet (Phase I). We check for its existence
 * via information_schema before counting rows.
 */
export async function assertModeChangeAllowed(
  eventId: string,
  force: boolean,
): Promise<{ forced: boolean }> {
  // Check if the abstracts table exists at all
  const tableExists = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'abstracts'
    ) AS "exists"
  `;

  if (!tableExists[0]?.exists) {
    // Table does not exist — no abstracts, change is safe
    return { forced: false };
  }

  // Table exists — count abstracts for this event
  const countResult = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS "count"
    FROM abstracts
    WHERE event_id = ${eventId}
  `;

  const abstractCount = Number(countResult[0]?.count ?? 0);

  if (abstractCount === 0) {
    return { forced: false };
  }

  if (!force) {
    throw new AppError(
      "Cannot change submission mode: abstracts already exist. Use force=true to override.",
      409,
      ErrorCodes.CONFLICT,
    );
  }

  return { forced: true };
}

// ============================================================================
// Themes
// ============================================================================

async function getConfigId(eventId: string): Promise<string> {
  const config = await getOrCreateConfig(eventId);
  return config.id;
}

export async function listThemes(eventId: string): Promise<AbstractTheme[]> {
  const configId = await getConfigId(eventId);
  return prisma.abstractTheme.findMany({
    where: { configId },
    orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
  });
}

export async function createTheme(
  eventId: string,
  body: CreateThemeInput,
): Promise<AbstractTheme> {
  const configId = await getConfigId(eventId);
  return prisma.abstractTheme.create({
    data: {
      configId,
      label: body.label,
      sortOrder: body.sortOrder ?? 0,
      active: body.active ?? true,
    },
  });
}

export async function updateTheme(
  eventId: string,
  themeId: string,
  body: UpdateThemeInput,
): Promise<AbstractTheme> {
  const theme = await prisma.abstractTheme.findUnique({
    where: { id: themeId },
    include: { config: { select: { eventId: true } } },
  });

  if (!theme || theme.config.eventId !== eventId) {
    throw new AppError("Theme not found", 404, ErrorCodes.NOT_FOUND);
  }

  return prisma.abstractTheme.update({
    where: { id: themeId },
    data: {
      ...(body.label !== undefined && { label: body.label }),
      ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
      ...(body.active !== undefined && { active: body.active }),
    },
  });
}

export async function softDeleteTheme(
  eventId: string,
  themeId: string,
): Promise<void> {
  const theme = await prisma.abstractTheme.findUnique({
    where: { id: themeId },
    include: { config: { select: { eventId: true } } },
  });

  if (!theme || theme.config.eventId !== eventId) {
    throw new AppError("Theme not found", 404, ErrorCodes.NOT_FOUND);
  }

  await prisma.abstractTheme.update({
    where: { id: themeId },
    data: { active: false },
  });
}

// ============================================================================
// Additional Fields
// ============================================================================

export async function getAdditionalFields(
  eventId: string,
): Promise<{ fields: unknown[] }> {
  const config = await getOrCreateConfig(eventId);
  return { fields: config.additionalFieldsSchema as unknown[] };
}

export async function setAdditionalFields(
  eventId: string,
  body: AdditionalFieldsInput,
  performedBy: string,
): Promise<{ fields: unknown[] }> {
  const config = await getOrCreateConfig(eventId);

  await prisma.abstractConfig.update({
    where: { id: config.id },
    data: {
      additionalFieldsSchema: body.fields as unknown as Prisma.InputJsonValue,
    },
  });

  await auditLog(prisma, {
    entityType: "AbstractConfig",
    entityId: config.id,
    action: "UPDATE",
    changes: {
      additionalFieldsSchema: {
        old: config.additionalFieldsSchema,
        new: body.fields,
      },
    },
    performedBy,
  });

  return { fields: body.fields };
}
