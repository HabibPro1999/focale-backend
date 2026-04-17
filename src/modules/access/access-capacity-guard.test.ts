import { describe, it, expect } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import { createMockEventAccess } from "../../../tests/helpers/factories.js";
import { updateEventAccess } from "@modules/access/access.service.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";

// ============================================================================
// Fix 4 — Capacity-decrease guard in updateEventAccess
//
// Rejecting maxCapacity < paidCount prevents the system from entering an
// invalid state where settled registrations exceed the declared limit.
// ============================================================================

function makeAccessWithRelations(overrides: Parameters<typeof createMockEventAccess>[0] = {}) {
  const base = createMockEventAccess(overrides);
  return {
    ...base,
    requiredAccess: [],
    event: {
      startDate: new Date("2025-06-01"),
      endDate: new Date("2025-06-03"),
    },
  };
}

describe("updateEventAccess — capacity-decrease guard", () => {
  it("should reject maxCapacity below current paidCount", async () => {
    const existing = makeAccessWithRelations({
      id: "access-1",
      paidCount: 10,
      maxCapacity: 20,
    });

    prismaMock.eventAccess.findUnique.mockResolvedValue(existing as never);

    await expect(
      updateEventAccess("access-1", { maxCapacity: 9 }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: ErrorCodes.CAPACITY_BELOW_REGISTERED,
    });

    await expect(
      updateEventAccess("access-1", { maxCapacity: 9 }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("should allow maxCapacity equal to current paidCount", async () => {
    const existing = makeAccessWithRelations({
      id: "access-1",
      paidCount: 10,
      maxCapacity: 20,
    });

    const updated = makeAccessWithRelations({
      id: "access-1",
      paidCount: 10,
      maxCapacity: 10,
    });

    prismaMock.eventAccess.findUnique.mockResolvedValue(existing as never);

    // maxCapacity changes 20→10, so the tx path is taken (isCapacityChanging=true)
    prismaMock.$transaction.mockImplementation(
      async (fn: (tx: typeof prismaMock) => Promise<unknown>) => fn(prismaMock),
    );
    prismaMock.eventAccess.update.mockResolvedValue(updated as never);
    // handleCapacityReached runs (paidCount=10 >= maxCapacity=10); batch-fetch finds no regs
    prismaMock.eventAccess.findMany.mockResolvedValue([updated as never]);
    prismaMock.registration.findMany.mockResolvedValue([]);

    const result = await updateEventAccess("access-1", { maxCapacity: 10 });

    expect(result.maxCapacity).toBe(10);
    expect(prismaMock.eventAccess.update).toHaveBeenCalled();
  });

  it("should allow maxCapacity: null (unlimited) regardless of paidCount", async () => {
    const existing = makeAccessWithRelations({
      id: "access-1",
      paidCount: 50,
      maxCapacity: 50,
    });

    const updated = makeAccessWithRelations({
      id: "access-1",
      paidCount: 50,
      maxCapacity: null,
    });

    prismaMock.eventAccess.findUnique.mockResolvedValue(existing as never);

    // maxCapacity changes 50→null, so the tx path is taken (isCapacityChanging=true)
    prismaMock.$transaction.mockImplementation(
      async (fn: (tx: typeof prismaMock) => Promise<unknown>) => fn(prismaMock),
    );
    prismaMock.eventAccess.update.mockResolvedValue(updated as never);

    const result = await updateEventAccess("access-1", { maxCapacity: null });

    expect(result.maxCapacity).toBeNull();
    expect(prismaMock.eventAccess.update).toHaveBeenCalled();
  });
});
