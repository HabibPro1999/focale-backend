import { describe, it, expect, beforeEach, vi } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import { faker } from "@faker-js/faker";
import type { AbstractConfig, AbstractTheme } from "@/generated/prisma/client.js";
import {
  getOrCreateConfig,
  updateConfig,
  assertModeChangeAllowed,
  listThemes,
  createTheme,
  updateTheme,
  softDeleteTheme,
  getAdditionalFields,
  setAdditionalFields,
} from "./abstracts.config.service.js";

// Mock audit
vi.mock("@shared/utils/audit.js", () => ({
  auditLog: vi.fn(),
}));

import { auditLog as mockAuditLog } from "@shared/utils/audit.js";

const eventId = faker.string.uuid();
const configId = faker.string.uuid();
const userId = faker.string.uuid();

function makeConfig(overrides: Partial<AbstractConfig> = {}): AbstractConfig {
  return {
    id: configId,
    eventId,
    submissionMode: "FREE_TEXT",
    globalWordLimit: null,
    sectionWordLimits: null,
    submissionDeadline: null,
    editingDeadline: null,
    scoringDeadline: null,
    finalFileDeadline: null,
    editingEnabled: false,
    commentsEnabled: false,
    commentsSentToAuthor: false,
    finalFileUploadEnabled: false,
    reviewersPerAbstract: 2,
    divergenceThreshold: 5,
    distributeByTheme: true,
    modeLocked: false,
    bookFontFamily: "Times New Roman",
    bookFontSize: 12,
    bookLineSpacing: 1.5,
    bookOrder: "BY_CODE",
    bookIncludeAuthorNames: true,
    additionalFieldsSchema: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeTheme(overrides: Partial<AbstractTheme> = {}): AbstractTheme {
  return {
    id: overrides.id ?? faker.string.uuid(),
    configId,
    label: "Theme A",
    sortOrder: 0,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ============================================================================
// getOrCreateConfig
// ============================================================================

describe("getOrCreateConfig", () => {
  it("returns existing config when present", async () => {
    const existing = makeConfig();
    prismaMock.abstractConfig.findUnique.mockResolvedValue(existing);

    const result = await getOrCreateConfig(eventId);

    expect(result).toEqual(existing);
    expect(prismaMock.abstractConfig.create).not.toHaveBeenCalled();
  });

  it("creates config with defaults when missing", async () => {
    const created = makeConfig();
    prismaMock.abstractConfig.findUnique.mockResolvedValue(null);
    prismaMock.abstractConfig.create.mockResolvedValue(created);

    const result = await getOrCreateConfig(eventId);

    expect(result).toEqual(created);
    expect(prismaMock.abstractConfig.create).toHaveBeenCalledWith({
      data: { eventId },
    });
  });
});

// ============================================================================
// updateConfig
// ============================================================================

describe("updateConfig", () => {
  beforeEach(() => {
    // getOrCreateConfig will find existing
    prismaMock.abstractConfig.findUnique.mockResolvedValue(makeConfig());
  });

  it("merges fields and writes audit log", async () => {
    const updated = makeConfig({ editingEnabled: true });
    prismaMock.abstractConfig.update.mockResolvedValue(updated);

    const result = await updateConfig(eventId, { editingEnabled: true }, userId);

    expect(result.editingEnabled).toBe(true);
    expect(prismaMock.abstractConfig.update).toHaveBeenCalledWith({
      where: { id: configId },
      data: { editingEnabled: true },
    });
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entityType: "AbstractConfig",
        entityId: configId,
        action: "UPDATE",
        performedBy: userId,
      }),
    );
  });

  it("rejects mode change when locked and force=false", async () => {
    // abstracts table exists with rows
    prismaMock.$queryRaw.mockResolvedValueOnce([{ exists: true }]);
    prismaMock.$queryRaw.mockResolvedValueOnce([{ count: BigInt(3) }]);

    await expect(
      updateConfig(eventId, { submissionMode: "STRUCTURED" }, userId),
    ).rejects.toThrow(/Cannot change submission mode/);
  });

  it("allows mode change when locked and force=true, writes audit", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ exists: true }]);
    prismaMock.$queryRaw.mockResolvedValueOnce([{ count: BigInt(3) }]);

    const updated = makeConfig({ submissionMode: "STRUCTURED" });
    prismaMock.abstractConfig.update.mockResolvedValue(updated);

    await updateConfig(
      eventId,
      { submissionMode: "STRUCTURED", force: true },
      userId,
    );

    // Should have called auditLog twice: once for force, once for UPDATE
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "mode_force_changed",
        changes: {
          submissionMode: { old: "FREE_TEXT", new: "STRUCTURED" },
        },
      }),
    );
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "UPDATE" }),
    );
  });

  it("accepts deadlines in the past without error", async () => {
    const pastDate = "2020-01-01T00:00:00.000Z";
    const updated = makeConfig({
      submissionDeadline: new Date(pastDate),
    });
    prismaMock.abstractConfig.update.mockResolvedValue(updated);

    const result = await updateConfig(
      eventId,
      { submissionDeadline: pastDate },
      userId,
    );

    expect(result.submissionDeadline).toEqual(new Date(pastDate));
  });
});

// ============================================================================
// assertModeChangeAllowed
// ============================================================================

describe("assertModeChangeAllowed", () => {
  it("returns forced=false when abstracts table does not exist", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ exists: false }]);

    const result = await assertModeChangeAllowed(eventId, false);
    expect(result).toEqual({ forced: false });
  });

  it("returns forced=false when table exists but no abstracts", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ exists: true }]);
    prismaMock.$queryRaw.mockResolvedValueOnce([{ count: BigInt(0) }]);

    const result = await assertModeChangeAllowed(eventId, false);
    expect(result).toEqual({ forced: false });
  });

  it("throws 409 when abstracts exist and force=false", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ exists: true }]);
    prismaMock.$queryRaw.mockResolvedValueOnce([{ count: BigInt(5) }]);

    await expect(assertModeChangeAllowed(eventId, false)).rejects.toThrow(
      /Cannot change submission mode/,
    );
  });

  it("returns forced=true when abstracts exist and force=true", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ exists: true }]);
    prismaMock.$queryRaw.mockResolvedValueOnce([{ count: BigInt(5) }]);

    const result = await assertModeChangeAllowed(eventId, true);
    expect(result).toEqual({ forced: true });
  });
});

// ============================================================================
// Themes
// ============================================================================

describe("listThemes", () => {
  it("returns themes for the event", async () => {
    const themes = [makeTheme({ label: "A" }), makeTheme({ label: "B" })];
    prismaMock.abstractConfig.findUnique.mockResolvedValue(makeConfig());
    prismaMock.abstractTheme.findMany.mockResolvedValue(themes);

    const result = await listThemes(eventId);

    expect(result).toEqual(themes);
    expect(prismaMock.abstractTheme.findMany).toHaveBeenCalledWith({
      where: { configId },
      orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
    });
  });
});

describe("createTheme", () => {
  it("creates and returns a theme", async () => {
    prismaMock.abstractConfig.findUnique.mockResolvedValue(makeConfig());
    const theme = makeTheme({ label: "New Theme" });
    prismaMock.abstractTheme.create.mockResolvedValue(theme);

    const result = await createTheme(eventId, { label: "New Theme" });

    expect(result).toEqual(theme);
    expect(prismaMock.abstractTheme.create).toHaveBeenCalledWith({
      data: {
        configId,
        label: "New Theme",
        sortOrder: 0,
        active: true,
      },
    });
  });
});

describe("updateTheme", () => {
  it("updates a theme that belongs to the event", async () => {
    const themeId = faker.string.uuid();
    const themeWithConfig = {
      ...makeTheme({ id: themeId }),
      config: { eventId },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prismaMock.abstractTheme.findUnique.mockResolvedValue(themeWithConfig as any);
    const updated = makeTheme({ id: themeId, label: "Updated" });
    prismaMock.abstractTheme.update.mockResolvedValue(updated);

    const result = await updateTheme(eventId, themeId, { label: "Updated" });
    expect(result.label).toBe("Updated");
  });

  it("throws 404 for a theme belonging to another event", async () => {
    const themeId = faker.string.uuid();
    const themeWithConfig = {
      ...makeTheme({ id: themeId }),
      config: { eventId: faker.string.uuid() },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prismaMock.abstractTheme.findUnique.mockResolvedValue(themeWithConfig as any);

    await expect(
      updateTheme(eventId, themeId, { label: "X" }),
    ).rejects.toThrow(/Theme not found/);
  });
});

describe("softDeleteTheme", () => {
  it("sets active=false on the theme", async () => {
    const themeId = faker.string.uuid();
    const themeWithConfig = {
      ...makeTheme({ id: themeId }),
      config: { eventId },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prismaMock.abstractTheme.findUnique.mockResolvedValue(themeWithConfig as any);
    prismaMock.abstractTheme.update.mockResolvedValue(
      makeTheme({ id: themeId, active: false }),
    );

    await softDeleteTheme(eventId, themeId);

    expect(prismaMock.abstractTheme.update).toHaveBeenCalledWith({
      where: { id: themeId },
      data: { active: false },
    });
  });
});

// ============================================================================
// Additional Fields
// ============================================================================

describe("getAdditionalFields", () => {
  it("returns the parsed fields from config", async () => {
    const fields = [{ id: "f1", type: "text", label: "Custom" }];
    prismaMock.abstractConfig.findUnique.mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeConfig({ additionalFieldsSchema: fields as any }),
    );

    const result = await getAdditionalFields(eventId);
    expect(result).toEqual({ fields });
  });
});

describe("setAdditionalFields", () => {
  it("saves fields and writes audit log", async () => {
    const config = makeConfig();
    prismaMock.abstractConfig.findUnique.mockResolvedValue(config);
    prismaMock.abstractConfig.update.mockResolvedValue(config);

    const fields = [{ id: "f1", type: "text" as const, label: "Custom" }];
    const result = await setAdditionalFields(eventId, { fields }, userId);

    expect(result).toEqual({ fields });
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entityType: "AbstractConfig",
        action: "UPDATE",
        performedBy: userId,
      }),
    );
  });
});
