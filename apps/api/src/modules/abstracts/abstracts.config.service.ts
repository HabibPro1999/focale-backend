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
  countCodedAbstractsByTheme,
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
  /**
   * H11: modeLocked was never written, so the admin UI (which only shows the
   * force-change confirmation when modeLocked is true) could never learn it
   * needed to send force=true — a perpetual generic 409. Report the truthful
   * value here: locked once abstracts exist for the event, same condition
   * assertModeChangeAllowed already gates on.
   */
  async getOrCreateConfig(eventId: string): Promise<AbstractConfigRow> {
    const config = await getOrCreateAbstractConfig(eventId);
    if (config.modeLocked) return config;
    const locked =
      (await abstractsTableExists()) && (await countAbstractsByEvent(eventId)) > 0;
    return locked ? { ...config, modeLocked: true } : config;
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

    this.assertValidDeadlineWindows(config, data);

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

  /**
   * M5: DEADLINE_FIELDS were persisted independently with no comparison
   * between them, so an inverted submission window or scoring-opens-before-
   * submission-closes could be saved silently. Validate the EFFECTIVE
   * configuration (existing row values with the incoming patch merged over
   * them) so partial patches are checked against the merged result, not just
   * the fields they touch. Only pairs where both sides are non-null are
   * checked — clearing a field to null always passes.
   */
  private assertValidDeadlineWindows(
    config: AbstractConfigRow,
    data: Record<string, unknown>,
  ): void {
    const effective = (key: (typeof DEADLINE_FIELDS)[number]): Date | null =>
      (Object.prototype.hasOwnProperty.call(data, key)
        ? (data[key] as Date | null)
        : config[key]) ?? null;

    const submissionStartAt = effective("submissionStartAt");
    const submissionDeadline = effective("submissionDeadline");
    const scoringStartAt = effective("scoringStartAt");
    const scoringDeadline = effective("scoringDeadline");

    const violations: Record<string, string> = {};
    if (
      submissionStartAt &&
      submissionDeadline &&
      submissionStartAt > submissionDeadline
    ) {
      violations.submissionWindow =
        "submissionStartAt must not be after submissionDeadline";
    }
    if (scoringStartAt && scoringDeadline && scoringStartAt > scoringDeadline) {
      violations.scoringWindow =
        "scoringStartAt must not be after scoringDeadline";
    }
    if (
      scoringStartAt &&
      submissionDeadline &&
      scoringStartAt < submissionDeadline
    ) {
      violations.scoringBeforeSubmissionClose =
        "scoringStartAt must not be before submissionDeadline";
    }

    if (Object.keys(violations).length > 0) {
      throw new AppException(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid abstract config: deadline windows are inconsistent",
        422,
        { violations },
      );
    }
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

  /**
   * H5: abstract codes embed the live theme.sortOrder (OC<sortOrder>-NN).
   * Two themes sharing a sortOrder collide on the unique (eventId, code)
   * index once both get coded — reject up front instead of failing at
   * finalize time. Only ACTIVE themes can collide; a reused sortOrder from a
   * soft-deleted theme is fine.
   */
  private assertSortOrderAvailable(
    themes: AbstractThemeRow[],
    sortOrder: number,
    excludeThemeId?: string,
  ): void {
    const conflict = themes.find(
      (t) => t.active && t.sortOrder === sortOrder && t.id !== excludeThemeId,
    );
    if (conflict) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `sortOrder ${sortOrder} is already used by another active theme`,
        409,
        { sortOrder, conflictingThemeId: conflict.id },
      );
    }
  }

  async createTheme(
    eventId: string,
    body: CreateThemeInput,
  ): Promise<AbstractThemeRow> {
    const configId = await this.getConfigId(eventId);
    const themes = await listThemesByConfigId(configId);
    // H5: default to max(sortOrder)+1, not a hardcoded 0 — two themes both
    // defaulting to 0 is exactly the collision this guards against.
    const sortOrder =
      body.sortOrder ??
      themes.reduce((max, t) => Math.max(max, t.sortOrder), -1) + 1;
    this.assertSortOrderAvailable(themes, sortOrder);
    return insertTheme({
      configId,
      label: body.label,
      description: body.description?.trim() || null,
      sortOrder,
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
    if (
      body.sortOrder !== undefined &&
      body.sortOrder !== found.theme.sortOrder
    ) {
      const codedCount = await countCodedAbstractsByTheme(themeId);
      if (codedCount > 0) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          "Cannot change sortOrder: theme already has coded abstracts",
          409,
          { themeId, codedAbstractCount: codedCount },
        );
      }
      const themes = await listThemesByConfigId(found.theme.configId);
      this.assertSortOrderAvailable(themes, body.sortOrder, themeId);
      data.sortOrder = body.sortOrder;
    }
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

    // H15: a field id dropped from the schema orphans any stored answer
    // keyed by that id (sanitizeFormData discards unknown keys on the next
    // edit). Block it once abstracts exist, unless the caller opts in with
    // force=true.
    const existingFields = Array.isArray(config.additionalFieldsSchema)
      ? (config.additionalFieldsSchema as { id?: unknown }[])
      : [];
    const existingIds = existingFields
      .map((f) => f?.id)
      .filter((id): id is string => typeof id === "string");
    const incomingIds = new Set(body.fields.map((f) => f.id));
    const droppedIds = existingIds.filter((id) => !incomingIds.has(id));

    if (droppedIds.length > 0 && !body.force) {
      const abstractCount = (await abstractsTableExists())
        ? await countAbstractsByEvent(eventId)
        : 0;
      if (abstractCount > 0) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          "Removing field ids would orphan stored answers for existing abstracts. Use force=true to override.",
          409,
          { removedFieldIds: droppedIds },
        );
      }
    }

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
