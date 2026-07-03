import { Injectable } from "@nestjs/common";
import {
  ErrorCodes,
  type PatchConfigInput,
  type CreateThemeInput,
  type UpdateThemeInput,
  type AdditionalFieldsInput,
} from "@app/contracts";
import {
  getOrCreateAbstractConfig,
  updateAbstractConfig,
  abstractsTableExists,
  countAbstractsByEvent,
  insertAuditLog,
  listThemesByConfigId,
  insertTheme,
  findThemeWithEventId,
  updateThemeRow,
  softDeleteThemeRow,
  type AbstractConfigRow,
  type AbstractThemeRow,
} from "@app/db";
import { AppException } from "../../core/app-exception";

const SCALAR_FIELDS = [
  "submissionMode",
  "globalWordLimit",
  "sectionWordLimits",
  "editingEnabled",
  "commentsEnabled",
  "commentsSentToAuthor",
  "finalFileUploadEnabled",
  "reviewersPerAbstract",
  "divergenceThreshold",
  "maxThemesPerAbstract",
  "distributeByTheme",
  "bookFontFamily",
  "bookFontSize",
  "bookLineSpacing",
  "bookOrder",
  "bookIncludeAuthorNames",
] as const;

const DEADLINE_FIELDS = [
  "submissionStartAt",
  "submissionDeadline",
  "editingDeadline",
  "scoringStartAt",
  "scoringDeadline",
  "finalFileDeadline",
] as const;

@Injectable()
export class AbstractsConfigService {
  getOrCreateConfig(eventId: string): Promise<AbstractConfigRow> {
    return getOrCreateAbstractConfig(eventId);
  }

  async updateConfig(
    eventId: string,
    patch: PatchConfigInput,
    performedBy: string,
  ): Promise<AbstractConfigRow> {
    const config = await getOrCreateAbstractConfig(eventId);
    const { force, ...fields } = patch;

    // Mode-lock check
    if (
      fields.submissionMode !== undefined &&
      fields.submissionMode !== config.submissionMode
    ) {
      const { forced } = await this.assertModeChangeAllowed(
        eventId,
        force ?? false,
      );
      if (forced) {
        await insertAuditLog({
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

    // Build update data (only fields present in the patch).
    const data: Record<string, unknown> = {};
    for (const key of SCALAR_FIELDS) {
      if (fields[key] !== undefined) data[key] = fields[key];
    }
    for (const key of DEADLINE_FIELDS) {
      const value = fields[key];
      if (value !== undefined) {
        data[key] = value === null ? null : new Date(value);
      }
    }

    const updated = await updateAbstractConfig(config.id, data);

    // Diff of every patched field (old vs new) for the audit log.
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) {
        changes[k] = {
          old: (config as Record<string, unknown>)[k],
          new: (updated as Record<string, unknown>)[k],
        };
      }
    }

    await insertAuditLog({
      entityType: "AbstractConfig",
      entityId: config.id,
      action: "UPDATE",
      changes,
      performedBy,
    });

    return updated;
  }

  /**
   * Whether changing submissionMode is allowed. The abstracts table may not
   * exist yet (Phase I) — probe first, then count rows for the event.
   */
  async assertModeChangeAllowed(
    eventId: string,
    force: boolean,
  ): Promise<{ forced: boolean }> {
    if (!(await abstractsTableExists())) {
      return { forced: false };
    }
    const abstractCount = await countAbstractsByEvent(eventId);
    if (abstractCount === 0) {
      return { forced: false };
    }
    if (!force) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        "Cannot change submission mode: abstracts already exist. Use force=true to override.",
        409,
      );
    }
    return { forced: true };
  }

  // --------------------------------------------------------------------------
  // Themes
  // --------------------------------------------------------------------------
  private async getConfigId(eventId: string): Promise<string> {
    const config = await getOrCreateAbstractConfig(eventId);
    return config.id;
  }

  async listThemes(eventId: string): Promise<AbstractThemeRow[]> {
    const configId = await this.getConfigId(eventId);
    return listThemesByConfigId(configId);
  }

  async createTheme(
    eventId: string,
    body: CreateThemeInput,
  ): Promise<AbstractThemeRow> {
    const configId = await this.getConfigId(eventId);
    return insertTheme({
      configId,
      label: body.label,
      description: body.description?.trim() || null,
      sortOrder: body.sortOrder ?? 0,
      active: body.active ?? true,
    });
  }

  async updateTheme(
    eventId: string,
    themeId: string,
    body: UpdateThemeInput,
  ): Promise<AbstractThemeRow> {
    const found = await findThemeWithEventId(themeId);
    if (!found || found.eventId !== eventId) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Theme not found", 404);
    }
    const data: Record<string, unknown> = {};
    if (body.label !== undefined) data.label = body.label;
    if (body.description !== undefined)
      data.description = body.description?.trim() || null;
    if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder;
    if (body.active !== undefined) data.active = body.active;
    return updateThemeRow(themeId, data);
  }

  async softDeleteTheme(eventId: string, themeId: string): Promise<void> {
    const found = await findThemeWithEventId(themeId);
    if (!found || found.eventId !== eventId) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Theme not found", 404);
    }
    await softDeleteThemeRow(themeId);
  }

  // --------------------------------------------------------------------------
  // Additional fields
  // --------------------------------------------------------------------------
  async getAdditionalFields(eventId: string): Promise<{ fields: unknown[] }> {
    const config = await getOrCreateAbstractConfig(eventId);
    return {
      fields: Array.isArray(config.additionalFieldsSchema)
        ? config.additionalFieldsSchema
        : [],
    };
  }

  async setAdditionalFields(
    eventId: string,
    body: AdditionalFieldsInput,
    performedBy: string,
  ): Promise<{ fields: unknown[] }> {
    const config = await getOrCreateAbstractConfig(eventId);
    await updateAbstractConfig(config.id, {
      additionalFieldsSchema: body.fields,
    });
    await insertAuditLog({
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
}
