import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AbstractConfigRow, AbstractThemeRow } from "@app/db";

vi.mock("@app/db", () => ({
  getOrCreateAbstractConfig: vi.fn(),
  updateAbstractConfig: vi.fn(),
  abstractsTableExists: vi.fn(),
  countAbstractsByEvent: vi.fn(),
  writeAbstractAuditLog: vi.fn(),
  listThemesByConfigId: vi.fn(),
  insertTheme: vi.fn(),
  findThemeWithEventId: vi.fn(),
  updateThemeRow: vi.fn(),
  softDeleteThemeRow: vi.fn(),
}));

import {
  getOrCreateAbstractConfig,
  updateAbstractConfig,
  abstractsTableExists,
  countAbstractsByEvent,
  writeAbstractAuditLog,
  listThemesByConfigId,
  insertTheme,
  findThemeWithEventId,
  updateThemeRow,
  softDeleteThemeRow,
} from "@app/db";
import { AbstractsConfigService } from "./abstracts.config.service";
import { AppException } from "./app-exception";

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
  it("delegates to the db fn", async () => {
    const config = makeConfig();
    mock(getOrCreateAbstractConfig).mockResolvedValue(config);
    expect(await service.getOrCreateConfig(eventId)).toBe(config);
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
    expect(writeAbstractAuditLog).toHaveBeenCalledWith(
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

    expect(writeAbstractAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "mode_force_changed",
        changes: { submissionMode: { old: "FREE_TEXT", new: "STRUCTURED" } },
      }),
    );
    expect(writeAbstractAuditLog).toHaveBeenCalledWith(
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

  it("creates a theme with defaults", async () => {
    const theme = makeTheme({ label: "New Theme" });
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
    expect(writeAbstractAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "AbstractConfig",
        action: "UPDATE",
        performedBy: userId,
      }),
    );
  });
});
