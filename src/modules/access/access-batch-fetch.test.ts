import { describe, it, expect, vi } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import { createMockEventAccess, createMockRegistration } from "../../../tests/helpers/factories.js";
import {
  handleCapacityReached,
  updateEventAccess,
} from "@modules/access/access.service.js";

// ============================================================================
// Fix 1+2 — Batch-fetch sponsorship usages (N+1 → 1 query)
//
// Both drop paths previously issued one sponsorshipUsage.findMany per
// registration. After the fix, a single batch query covers all regs.
// ============================================================================

function makeBreakdown(accessId: string, subtotal: number) {
  return {
    basePrice: 200,
    appliedRules: [],
    calculatedBasePrice: 200,
    accessItems: [{ accessId, quantity: 1, name: "Workshop", subtotal }],
    accessTotal: subtotal,
    subtotal: 200 + subtotal,
    sponsorships: [],
    sponsorshipTotal: 0,
    total: 200 + subtotal,
    currency: "TND",
    droppedAccessItems: [],
  };
}

const eventId = "event-batch-test";
const accessId = "access-batch-1";

// ============================================================================
// handleCapacityReached — batch fetch
// ============================================================================

describe("handleCapacityReached — sponsorshipUsage.findMany called once for N regs", () => {
  it("issues a single batch query instead of N per-registration queries", async () => {
    const findManySpy = vi.fn().mockResolvedValue([]);

    // Build 5 registrations each with the target access
    const registrations = Array.from({ length: 5 }, (_, i) =>
      createMockRegistration({
        id: `reg-${i}`,
        eventId,
        paymentStatus: "PENDING",
        accessTypeIds: [accessId],
        sponsorshipAmount: 0,
        priceBreakdown: makeBreakdown(accessId, 50),
      }),
    );

    const atCapacityAccess = createMockEventAccess({
      id: accessId,
      eventId,
      name: "Workshop",
      maxCapacity: 5,
      paidCount: 5,
    });

    const mockDb = {
      eventAccess: {
        findMany: vi.fn().mockResolvedValue([atCapacityAccess]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      registration: {
        findMany: vi.fn().mockResolvedValue(registrations),
        update: vi.fn().mockResolvedValue({}),
      },
      sponsorshipUsage: {
        findMany: findManySpy,
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({}),
      },
      $executeRaw: vi.fn().mockResolvedValue(1),
    };

    await handleCapacityReached(eventId, [accessId], mockDb as never);

    // Single query covers all 5 registrations — not 5 separate queries
    expect(findManySpy).toHaveBeenCalledTimes(1);
    expect(findManySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          registrationId: { in: expect.arrayContaining(["reg-0", "reg-1", "reg-2", "reg-3", "reg-4"]) },
        }),
      }),
    );
  });

  it("registrations covered by sponsorship are still skipped after batch fetch", async () => {
    const coveredRegId = "reg-covered";
    const uncoveredRegId = "reg-uncovered";

    const coveredReg = createMockRegistration({
      id: coveredRegId,
      eventId,
      paymentStatus: "PENDING",
      accessTypeIds: [accessId],
      sponsorshipAmount: 50,
      priceBreakdown: makeBreakdown(accessId, 50),
    });

    const uncoveredReg = createMockRegistration({
      id: uncoveredRegId,
      eventId,
      paymentStatus: "PENDING",
      accessTypeIds: [accessId],
      sponsorshipAmount: 0,
      priceBreakdown: makeBreakdown(accessId, 50),
    });

    const atCapacityAccess = createMockEventAccess({
      id: accessId,
      eventId,
      name: "Workshop",
      maxCapacity: 2,
      paidCount: 2,
    });

    const updateSpy = vi.fn().mockResolvedValue({});

    const mockDb = {
      eventAccess: {
        findMany: vi.fn().mockResolvedValue([atCapacityAccess]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      registration: {
        findMany: vi.fn().mockResolvedValue([coveredReg, uncoveredReg]),
        update: updateSpy,
      },
      sponsorshipUsage: {
        // Return coverage for the covered reg only
        findMany: vi.fn().mockResolvedValue([
          {
            registrationId: coveredRegId,
            sponsorship: { coveredAccessIds: [accessId] },
          },
        ]),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({}),
      },
      $executeRaw: vi.fn().mockResolvedValue(1),
    };

    const affected = await handleCapacityReached(eventId, [accessId], mockDb as never);

    // Only the uncovered reg should be updated
    expect(affected).toBe(1);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: uncoveredRegId } }),
    );
  });
});

// ============================================================================
// dropAccessFromUnsettledRegistrations — batch fetch (via updateEventAccess deactivation path)
// ============================================================================

describe("dropAccessFromUnsettledRegistrations — sponsorshipUsage.findMany called once for N regs", () => {
  it("issues a single batch query when access is deactivated", async () => {
    const existingAccess = {
      ...createMockEventAccess({
        id: accessId,
        eventId,
        name: "Workshop",
        active: true,
        paidCount: 0,
      }),
      requiredAccess: [],
      event: {
        startDate: new Date("2025-06-01"),
        endDate: new Date("2025-06-03"),
      },
    };

    const updatedAccess = { ...existingAccess, active: false };

    // 3 pending registrations with this access
    const registrations = Array.from({ length: 3 }, (_, i) =>
      createMockRegistration({
        id: `reg-drop-${i}`,
        eventId,
        paymentStatus: "PENDING",
        accessTypeIds: [accessId],
        sponsorshipAmount: 0,
        priceBreakdown: makeBreakdown(accessId, 50),
      }),
    );

    prismaMock.eventAccess.findUnique.mockResolvedValue(existingAccess as never);

    // $transaction passes tx (which is prismaMock itself) to the callback
    prismaMock.$transaction.mockImplementation(
      async (fn: (tx: typeof prismaMock) => Promise<unknown>) => fn(prismaMock),
    );

    prismaMock.eventAccess.update.mockResolvedValue(updatedAccess as never);
    prismaMock.registration.findMany.mockResolvedValue(registrations as never);
    prismaMock.sponsorshipUsage.findMany.mockResolvedValue([]);
    prismaMock.registration.update.mockResolvedValue({} as never);
    prismaMock.eventAccess.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.auditLog.create.mockResolvedValue({} as never);

    await updateEventAccess(accessId, { active: false });

    // Should have been called exactly once (batch), not 3 times (per reg)
    expect(prismaMock.sponsorshipUsage.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.sponsorshipUsage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          registrationId: { in: expect.arrayContaining(["reg-drop-0", "reg-drop-1", "reg-drop-2"]) },
        }),
      }),
    );
  });
});
