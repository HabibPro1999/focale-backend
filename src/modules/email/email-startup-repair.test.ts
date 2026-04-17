/**
 * Fix 5 — Startup repair for stuck SENDING rows
 *
 * repairStaleSendingRows() should issue an UPDATE that transitions
 * email_logs rows stuck in SENDING for >5 minutes back to QUEUED,
 * and log the count of repaired rows.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import { repairStaleSendingRows } from "@modules/email/email-queue.service.js";

// Mock the logger so we can assert on it
vi.mock("@shared/utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    debug: vi.fn(),
  },
}));

import { logger } from "@shared/utils/logger.js";

describe("repairStaleSendingRows (Fix 5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes the raw UPDATE and logs when rows are repaired", async () => {
    // $executeRaw returns the number of affected rows
    prismaMock.$executeRaw.mockResolvedValue(3);

    await repairStaleSendingRows();

    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
    // The SQL should reference SENDING and QUEUED
    const call = prismaMock.$executeRaw.mock.calls[0];
    // call[0] is a TemplateStringsArray from Prisma.sql tag
    const sqlParts = Array.isArray(call[0]) ? call[0].join("") : String(call[0]);
    expect(sqlParts.toLowerCase()).toContain("sending");
    expect(sqlParts.toLowerCase()).toContain("queued");
    expect(sqlParts.toLowerCase()).toContain("5 minutes");

    // Logger should record the repaired count
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ repairedCount: 3 }),
      expect.any(String),
    );
  });

  it("does not log when no rows needed repair", async () => {
    prismaMock.$executeRaw.mockResolvedValue(0);

    await repairStaleSendingRows();

    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
    // No info log when count is 0
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("propagates database errors", async () => {
    prismaMock.$executeRaw.mockRejectedValue(new Error("DB connection lost"));

    await expect(repairStaleSendingRows()).rejects.toThrow("DB connection lost");
  });
});
