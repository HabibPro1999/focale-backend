import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AbstractConfigRow, AbstractThemeRow } from "@app/db";

vi.mock("@app/db", () => ({
  getOrCreateAbstractConfig: vi.fn(),
  updateAbstractConfig: vi.fn(),
  abstractsTableExists: vi.fn(),
  countAbstractsByEvent: vi.fn(),
  insertAuditLog: vi.fn(),
  listThemesByConfigId: vi.fn(),
  insertTheme: vi.fn(),
  findThemeWithEventId: vi.fn(),
  updateThemeRow: vi.fn(),
  softDeleteThemeRow: vi.fn(),
  countCodedAbstractsByTheme: vi.fn(),
}));

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
} from "@app/db";
import { AbstractsConfigService } from "./abstracts.config.service";
import { AppException } from "../../core/app-exception";

const mock = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

const eventId = "11111111-1111-4111-8111-111111111111";
const configId = "33333333-3333-4333-8333-333333333333";
const userId = "55555555-5555-4555-8555-555555555555";

function makeConfig(overrides: Partial<AbstractConfigRow> = {}): AbstractConfigRow {
  return {
    id: configId,
    eventId,
    submissionMode: "FREE_TEXT",
    globalWordLimit: null,
    sectionWordLimits: null,
    submissionStartAt: null,
    submissionDeadline: null,
    editingDeadline: null,
    scoringStartAt: null,
    scoringDeadline: null,
    finalFileDeadline: null,
    editingEnabled: false,
    commentsEnabled: false,
    commentsSentToAuthor: false,
    finalFileUploadEnabled: false,
    reviewersPerAbstract: 2,
    divergenceThreshold: 6,
    maxThemesPerAbstract: null,
    distributeByTheme: false,
    modeLocked: false,
    bookFontFamily: "Arial",
    bookFontSize: 11,
    bookLineSpacing: 1.5,
    bookOrder: "BY_CODE",
    bookIncludeAuthorNames: true,
    additionalFieldsSchema: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeTheme(overrides: Partial<AbstractThemeRow> = {}): AbstractThemeRow {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    configId,
    label: "Theme A",
    description: null,
    sortOrder: 0,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const service = new AbstractsConfigService();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getOrCreateConfig", () => {
  // H11: modeLocked was never written, so the admin UI (gated on
  // config.modeLocked) could never learn it needed force=true. The read
  // path must report the truthful value: locked once abstracts exist.
  it("reports modeLocked=false when no abstracts exist for the event", async () => {
    const config = makeConfig();
    mock(getOrCreateAbstractConfig).mockResolvedValue(config);
    mock(abstractsTableExists).mockResolvedValue(true);
    mock(countAbstractsByEvent).mockResolvedValue(0);
    const result = await service.getOrCreateConfig(eventId);
    expect(result.modeLocked).toBe(false);
  });

  it("reports modeLocked=true once abstracts exist for the event", async () => {
    const config = makeConfig();
    mock(getOrCreateAbstractConfig).mockResolvedValue(config);
    mock(abstractsTableExists).mockResolvedValue(true);
    mock(countAbstractsByEvent).mockResolvedValue(1);
    const result = await service.getOrCreateConfig(eventId);
    expect(result.modeLocked).toBe(true);
  });

  it("reports modeLocked=false when the abstracts table doesn't exist yet", async () => {
    const config = makeConfig();
    mock(getOrCreateAbstractConfig).mockResolvedValue(config);
    mock(abstractsTableExists).mockResolvedValue(false);
    const result = await service.getOrCreateConfig(eventId);
    expect(result.modeLocked).toBe(false);
    expect(countAbstractsByEvent).not.toHaveBeenCalled();
  });

  it("passes through modeLocked=true without re-querying abstract count", async () => {
    const config = makeConfig({ modeLocked: true });
    mock(getOrCreateAbstractConfig).mockResolvedValue(config);
    const result = await service.getOrCreateConfig(eventId);
    expect(result.modeLocked).toBe(true);
    expect(abstractsTableExists).not.toHaveBeenCalled();
  });
});

describe("updateConfig", () => {
  beforeEach(() => {
    mock(getOrCreateAbstractConfig).mockResolvedValue(makeConfig());
  });

  it("merges patched fields and writes the UPDATE audit log", async () => {
    mock(updateAbstractConfig).mockResolvedValue(makeConfig({ editingEnabled: true }));
    const result = await service.updateConfig(eventId, { editingEnabled: true }, userId);
    expect(result.editingEnabled).toBe(true);
    expect(updateAbstractConfig).toHaveBeenCalledWith(configId, {
      editingEnabled: true,
    });
    expect(insertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "AbstractConfig",
        entityId: configId,
        action: "UPDATE",
        performedBy: userId,
      }),
    );
  });

  it("rejects a mode change when locked and force=false", async () => {
    mock(abstractsTableExists).mockResolvedValue(true);
    mock(countAbstractsByEvent).mockResolvedValue(3);
    await expect(
      service.updateConfig(eventId, { submissionMode: "STRUCTURED" }, userId),
    ).rejects.toThrow(/Cannot change submission mode/);
  });

  it("allows a forced mode change and writes the extra mode_force_changed audit", async () => {
    mock(abstractsTableExists).mockResolvedValue(true);
    mock(countAbstractsByEvent).mockResolvedValue(3);
    mock(updateAbstractConfig).mockResolvedValue(makeConfig({ submissionMode: "STRUCTURED" }));

    await service.updateConfig(
      eventId,
      { submissionMode: "STRUCTURED", force: true },
      userId,
    );

    expect(insertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "mode_force_changed",
        changes: { submissionMode: { old: "FREE_TEXT", new: "STRUCTURED" } },
      }),
    );
    expect(insertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "UPDATE" }),
    );
    // `force` is stripped from the persisted data.
    expect(updateAbstractConfig).toHaveBeenCalledWith(configId, {
      submissionMode: "STRUCTURED",
    });
  });

  it("accepts past deadlines and converts them to Date", async () => {
    const past = "2020-01-01T00:00:00.000Z";
    mock(updateAbstractConfig).mockResolvedValue(
      makeConfig({ submissionDeadline: new Date(past) }),
    );
    const result = await service.updateConfig(eventId, { submissionDeadline: past }, userId);
    expect(result.submissionDeadline).toEqual(new Date(past));
    expect(updateAbstractConfig).toHaveBeenCalledWith(configId, {
      submissionDeadline: new Date(past),
    });
  });

  // M5: cross-field window validation on the EFFECTIVE (merged) config.
  describe("deadline window validation", () => {
    it("rejects an inverted submission window", async () => {
      await expect(
        service.updateConfig(
          eventId,
          {
            submissionStartAt: "2026-06-01T00:00:00.000Z",
            submissionDeadline: "2026-05-01T00:00:00.000Z",
          },
          userId,
        ),
      ).rejects.toThrow(/deadline windows are inconsistent/);
      expect(updateAbstractConfig).not.toHaveBeenCalled();
    });

    it("rejects scoring opening before the submission deadline", async () => {
      mock(getOrCreateAbstractConfig).mockResolvedValue(
        makeConfig({
          submissionDeadline: new Date("2026-06-01T00:00:00.000Z"),
        }),
      );
      await expect(
        service.updateConfig(
          eventId,
          { scoringStartAt: "2026-05-01T00:00:00.000Z" },
          userId,
        ),
      ).rejects.toThrow(/deadline windows are inconsistent/);
      expect(updateAbstractConfig).not.toHaveBeenCalled();
    });

    it("validates partial patches against the merged effective values", async () => {
      // Existing row already has submissionDeadline set; patch only touches
      // scoringStartAt, which conflicts with the *stored* submissionDeadline.
      mock(getOrCreateAbstractConfig).mockResolvedValue(
        makeConfig({
          submissionDeadline: new Date("2026-06-01T00:00:00.000Z"),
          scoringStartAt: new Date("2026-07-01T00:00:00.000Z"),
        }),
      );
      await expect(
        service.updateConfig(
          eventId,
          { scoringDeadline: "2026-01-01T00:00:00.000Z" },
          userId,
        ),
      ).rejects.toThrow(/deadline windows are inconsistent/);
    });

    it("allows clearing a field to null even if the other side is set", async () => {
      mock(getOrCreateAbstractConfig).mockResolvedValue(
        makeConfig({
          submissionStartAt: new Date("2026-06-01T00:00:00.000Z"),
          submissionDeadline: new Date("2026-01-01T00:00:00.000Z"),
        }),
      );
      mock(updateAbstractConfig).mockResolvedValue(
        makeConfig({ submissionDeadline: null }),
      );
      await expect(
        service.updateConfig(eventId, { submissionDeadline: null }, userId),
      ).resolves.toBeTruthy();
      expect(updateAbstractConfig).toHaveBeenCalledWith(configId, {
        submissionDeadline: null,
      });
    });
  });
});

describe("assertModeChangeAllowed", () => {
  it("forced=false when the abstracts table does not exist", async () => {
    mock(abstractsTableExists).mockResolvedValue(false);
    expect(await service.assertModeChangeAllowed(eventId, false)).toEqual({ forced: false });
  });
  it("forced=false when the table exists but no abstracts", async () => {
    mock(abstractsTableExists).mockResolvedValue(true);
    mock(countAbstractsByEvent).mockResolvedValue(0);
    expect(await service.assertModeChangeAllowed(eventId, false)).toEqual({ forced: false });
  });
  it("throws 409 when abstracts exist and force=false", async () => {
    mock(abstractsTableExists).mockResolvedValue(true);
    mock(countAbstractsByEvent).mockResolvedValue(5);
    await expect(service.assertModeChangeAllowed(eventId, false)).rejects.toThrow(
      /Cannot change submission mode/,
    );
  });
  it("forced=true when abstracts exist and force=true", async () => {
    mock(abstractsTableExists).mockResolvedValue(true);
    mock(countAbstractsByEvent).mockResolvedValue(5);
    expect(await service.assertModeChangeAllowed(eventId, true)).toEqual({ forced: true });
  });
});

describe("themes", () => {
  beforeEach(() => {
    mock(getOrCreateAbstractConfig).mockResolvedValue(makeConfig());
  });

  it("lists themes for the event's config", async () => {
    const themes = [makeTheme({ label: "A" }), makeTheme({ label: "B" })];
    mock(listThemesByConfigId).mockResolvedValue(themes);
    expect(await service.listThemes(eventId)).toBe(themes);
    expect(listThemesByConfigId).toHaveBeenCalledWith(configId);
  });

  it("creates a theme with defaults (sortOrder 0 when no themes exist yet)", async () => {
    const theme = makeTheme({ label: "New Theme" });
    mock(listThemesByConfigId).mockResolvedValue([]);
    mock(insertTheme).mockResolvedValue(theme);
    const result = await service.createTheme(eventId, { label: "New Theme" });
    expect(result).toBe(theme);
    expect(insertTheme).toHaveBeenCalledWith({
      configId,
      label: "New Theme",
      description: null,
      sortOrder: 0,
      active: true,
    });
  });

  // H5(a): auto-assign max(sortOrder)+1 instead of a hardcoded 0 — two
  // themes both defaulting to 0 collide on the printed code series.
  it("auto-assigns sortOrder = max(existing)+1 when not given explicitly", async () => {
    mock(listThemesByConfigId).mockResolvedValue([
      makeTheme({ id: "t1", sortOrder: 0 }),
      makeTheme({ id: "t2", sortOrder: 2 }),
    ]);
    mock(insertTheme).mockResolvedValue(makeTheme({ sortOrder: 3 }));
    await service.createTheme(eventId, { label: "New Theme" });
    expect(insertTheme).toHaveBeenCalledWith(
      expect.objectContaining({ sortOrder: 3 }),
    );
  });

  // H5(b): reject creating a theme at a sortOrder already used by another
  // ACTIVE theme of the same event.
  it("409s creating a theme at a sortOrder already used by an active theme", async () => {
    mock(listThemesByConfigId).mockResolvedValue([
      makeTheme({ id: "t1", sortOrder: 1, active: true }),
    ]);
    await expect(
      service.createTheme(eventId, { label: "Dup", sortOrder: 1 }),
    ).rejects.toThrow(/sortOrder 1 is already used/);
    expect(insertTheme).not.toHaveBeenCalled();
  });

  it("allows reusing a sortOrder held only by an inactive theme", async () => {
    mock(listThemesByConfigId).mockResolvedValue([
      makeTheme({ id: "t1", sortOrder: 1, active: false }),
    ]);
    mock(insertTheme).mockResolvedValue(makeTheme({ sortOrder: 1 }));
    await expect(
      service.createTheme(eventId, { label: "Ok", sortOrder: 1 }),
    ).resolves.toBeTruthy();
  });

  it("updates a theme that belongs to the event", async () => {
    mock(findThemeWithEventId).mockResolvedValue({ theme: makeTheme(), eventId });
    mock(updateThemeRow).mockResolvedValue(makeTheme({ label: "Updated" }));
    const result = await service.updateTheme(eventId, "theme-1", { label: "Updated" });
    expect(result.label).toBe("Updated");
    expect(updateThemeRow).toHaveBeenCalledWith("theme-1", { label: "Updated" });
  });

  it("404s updating a theme owned by another event", async () => {
    mock(findThemeWithEventId).mockResolvedValue({
      theme: makeTheme(),
      eventId: "other-event",
    });
    await expect(
      service.updateTheme(eventId, "theme-1", { label: "X" }),
    ).rejects.toThrow(/Theme not found/);
    expect(updateThemeRow).not.toHaveBeenCalled();
  });

  // H5(c): reject changing sortOrder once the theme has coded abstracts —
  // the printed series follows sortOrder, so moving it splits/collides it.
  it("409s changing sortOrder when the theme already has coded abstracts", async () => {
    mock(findThemeWithEventId).mockResolvedValue({
      theme: makeTheme({ id: "theme-1", sortOrder: 1 }),
      eventId,
    });
    mock(countCodedAbstractsByTheme).mockResolvedValue(2);
    await expect(
      service.updateTheme(eventId, "theme-1", { sortOrder: 5 }),
    ).rejects.toThrow(/already has coded abstracts/);
    expect(updateThemeRow).not.toHaveBeenCalled();
  });

  // H5(b): same active-sortOrder-collision guard applies on update.
  it("409s changing sortOrder to one already used by another active theme", async () => {
    mock(findThemeWithEventId).mockResolvedValue({
      theme: makeTheme({ id: "theme-1", sortOrder: 1, configId }),
      eventId,
    });
    mock(countCodedAbstractsByTheme).mockResolvedValue(0);
    mock(listThemesByConfigId).mockResolvedValue([
      makeTheme({ id: "theme-1", sortOrder: 1 }),
      makeTheme({ id: "theme-2", sortOrder: 5, active: true }),
    ]);
    await expect(
      service.updateTheme(eventId, "theme-1", { sortOrder: 5 }),
    ).rejects.toThrow(/sortOrder 5 is already used/);
    expect(updateThemeRow).not.toHaveBeenCalled();
  });

  it("allows changing sortOrder when no coded abstracts and no collision", async () => {
    mock(findThemeWithEventId).mockResolvedValue({
      theme: makeTheme({ id: "theme-1", sortOrder: 1, configId }),
      eventId,
    });
    mock(countCodedAbstractsByTheme).mockResolvedValue(0);
    mock(listThemesByConfigId).mockResolvedValue([
      makeTheme({ id: "theme-1", sortOrder: 1 }),
    ]);
    mock(updateThemeRow).mockResolvedValue(makeTheme({ sortOrder: 9 }));
    const result = await service.updateTheme(eventId, "theme-1", {
      sortOrder: 9,
    });
    expect(result.sortOrder).toBe(9);
    expect(updateThemeRow).toHaveBeenCalledWith("theme-1", { sortOrder: 9 });
  });

  it("soft-deletes (active=false) a theme it owns", async () => {
    mock(findThemeWithEventId).mockResolvedValue({ theme: makeTheme(), eventId });
    await service.softDeleteTheme(eventId, "theme-1");
    expect(softDeleteThemeRow).toHaveBeenCalledWith("theme-1");
  });

  it("404s soft-deleting a cross-event theme", async () => {
    mock(findThemeWithEventId).mockResolvedValue({
      theme: makeTheme(),
      eventId: "other-event",
    });
    await expect(service.softDeleteTheme(eventId, "theme-1")).rejects.toBeInstanceOf(
      AppException,
    );
    expect(softDeleteThemeRow).not.toHaveBeenCalled();
  });
});

describe("additional fields", () => {
  it("returns the stored fields", async () => {
    const fields = [{ id: "f1", type: "text", label: "Custom" }];
    mock(getOrCreateAbstractConfig).mockResolvedValue(
      makeConfig({ additionalFieldsSchema: fields }),
    );
    expect(await service.getAdditionalFields(eventId)).toEqual({ fields });
  });

  it("overwrites fields wholesale and writes an audit log", async () => {
    mock(getOrCreateAbstractConfig).mockResolvedValue(makeConfig());
    mock(updateAbstractConfig).mockResolvedValue(makeConfig());
    const fields = [{ id: "f1", type: "text" as const, label: "Custom" }];
    const result = await service.setAdditionalFields(eventId, { fields }, userId);
    expect(result).toEqual({ fields });
    expect(updateAbstractConfig).toHaveBeenCalledWith(configId, {
      additionalFieldsSchema: fields,
    });
    expect(insertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "AbstractConfig",
        action: "UPDATE",
        performedBy: userId,
      }),
    );
  });

  // H15: dropping a stored field id orphans any answer already keyed by it.
  describe("dropped field ids", () => {
    const existingFields = [
      { id: "f1", type: "text" as const, label: "Kept" },
      { id: "f2", type: "text" as const, label: "Removed" },
    ];

    it("409s dropping a field id when abstracts already exist", async () => {
      mock(getOrCreateAbstractConfig).mockResolvedValue(
        makeConfig({ additionalFieldsSchema: existingFields }),
      );
      mock(abstractsTableExists).mockResolvedValue(true);
      mock(countAbstractsByEvent).mockResolvedValue(1);
      const newFields = [{ id: "f1", type: "text" as const, label: "Kept" }];

      await expect(
        service.setAdditionalFields(eventId, { fields: newFields }, userId),
      ).rejects.toMatchObject({
        details: { removedFieldIds: ["f2"] },
      });
      expect(updateAbstractConfig).not.toHaveBeenCalled();
    });

    it("accepts a dropped field id with force=true even if abstracts exist", async () => {
      mock(getOrCreateAbstractConfig).mockResolvedValue(
        makeConfig({ additionalFieldsSchema: existingFields }),
      );
      mock(abstractsTableExists).mockResolvedValue(true);
      mock(countAbstractsByEvent).mockResolvedValue(1);
      mock(updateAbstractConfig).mockResolvedValue(makeConfig());
      const newFields = [{ id: "f1", type: "text" as const, label: "Kept" }];

      const result = await service.setAdditionalFields(
        eventId,
        { fields: newFields, force: true },
        userId,
      );
      expect(result).toEqual({ fields: newFields });
      expect(updateAbstractConfig).toHaveBeenCalledWith(configId, {
        additionalFieldsSchema: newFields,
      });
    });

    it("accepts an add-only change without force even if abstracts exist", async () => {
      mock(getOrCreateAbstractConfig).mockResolvedValue(
        makeConfig({ additionalFieldsSchema: existingFields }),
      );
      mock(abstractsTableExists).mockResolvedValue(true);
      mock(countAbstractsByEvent).mockResolvedValue(1);
      mock(updateAbstractConfig).mockResolvedValue(makeConfig());
      const newFields = [
        ...existingFields,
        { id: "f3", type: "text" as const, label: "Added" },
      ];

      await expect(
        service.setAdditionalFields(eventId, { fields: newFields }, userId),
      ).resolves.toEqual({ fields: newFields });
    });

    it("accepts a dropped field id without force when no abstracts exist yet", async () => {
      mock(getOrCreateAbstractConfig).mockResolvedValue(
        makeConfig({ additionalFieldsSchema: existingFields }),
      );
      mock(abstractsTableExists).mockResolvedValue(true);
      mock(countAbstractsByEvent).mockResolvedValue(0);
      mock(updateAbstractConfig).mockResolvedValue(makeConfig());
      const newFields = [{ id: "f1", type: "text" as const, label: "Kept" }];

      await expect(
        service.setAdditionalFields(eventId, { fields: newFields }, userId),
      ).resolves.toEqual({ fields: newFields });
    });
  });
});
