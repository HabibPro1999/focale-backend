import { describe, it, expect, vi } from "vitest";
import { AdminEditRegistrationSchema } from "@modules/registrations/registrations.schema.js";

// ============================================================================
// AdminEditRegistrationSchema — sponsorshipAmount is NOT admin-settable
// ============================================================================

describe("AdminEditRegistrationSchema — sponsorshipAmount not settable", () => {
  it("rejects unknown key sponsorshipAmount (strictObject)", () => {
    const result = AdminEditRegistrationSchema.safeParse({
      sponsorshipAmount: 999,
    });
    // strictObject rejects unrecognised keys
    expect(result.success).toBe(false);
  });

  it("accepts a valid edit without sponsorshipAmount", () => {
    const result = AdminEditRegistrationSchema.safeParse({
      note: "Manually updated by admin",
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// recomputeSponsorshipAmount helper — unit-level tx mock
// ============================================================================

import { recomputeSponsorshipAmount } from "@modules/registrations/registrations.service.js";

// Mock prisma — the function only needs the tx client. We keep the structural
// mock type at the call site so assertions can read `tx.registration.update`
// directly; pass `as never` when handing it to the typed function under test.
function makeTxMock(overrides: {
  usages?: Array<{ amountApplied: number }>;
  registration?: {
    priceBreakdown: unknown;
    baseAmount: number;
    accessAmount: number;
    discountAmount: number;
  } | null;
}) {
  return {
    sponsorshipUsage: {
      findMany: vi.fn().mockResolvedValue(overrides.usages ?? []),
    },
    registration: {
      findUnique: vi.fn().mockResolvedValue(
        overrides.registration !== undefined
          ? overrides.registration
          : {
              priceBreakdown: { accessItems: [], sponsorshipTotal: 0, total: 300 },
              baseAmount: 300,
              accessAmount: 0,
              discountAmount: 0,
            },
      ),
      update: vi.fn().mockResolvedValue({}),
    },
  };
}

describe("recomputeSponsorshipAmount", () => {
  it("sets sponsorshipAmount to 0 when no usages", async () => {
    const tx = makeTxMock({ usages: [] });
    await recomputeSponsorshipAmount(tx as never, "reg-1");
    expect(tx.registration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sponsorshipAmount: 0 }),
      }),
    );
  });

  it("sums all usage amounts", async () => {
    const tx = makeTxMock({
      usages: [{ amountApplied: 100 }, { amountApplied: 50 }],
    });
    await recomputeSponsorshipAmount(tx as never, "reg-1");
    expect(tx.registration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sponsorshipAmount: 150 }),
      }),
    );
  });

  it("updates priceBreakdown.sponsorshipTotal", async () => {
    const tx = makeTxMock({
      usages: [{ amountApplied: 200 }],
      registration: {
        priceBreakdown: { accessItems: [], sponsorshipTotal: 0, total: 300 },
        baseAmount: 300,
        accessAmount: 0,
        discountAmount: 0,
      },
    });
    await recomputeSponsorshipAmount(tx as never, "reg-1");
    const call = tx.registration.update.mock.calls[0][0] as {
      data: { priceBreakdown: { sponsorshipTotal: number; total: number } };
    };
    expect(call.data.priceBreakdown.sponsorshipTotal).toBe(200);
  });

  it("sets total = base + access - discount - sponsorship (floor 0)", async () => {
    const tx = makeTxMock({
      usages: [{ amountApplied: 500 }], // more than total (over-sponsored)
      registration: {
        priceBreakdown: { accessItems: [], sponsorshipTotal: 0, total: 300 },
        baseAmount: 300,
        accessAmount: 0,
        discountAmount: 0,
      },
    });
    await recomputeSponsorshipAmount(tx as never, "reg-1");
    const call = tx.registration.update.mock.calls[0][0] as {
      data: { priceBreakdown: { sponsorshipTotal: number; total: number } };
    };
    expect(call.data.priceBreakdown.total).toBe(0); // Math.max(0, 300-500)
  });

  it("is a no-op when registration not found", async () => {
    const tx = makeTxMock({ registration: null });
    await recomputeSponsorshipAmount(tx as never, "missing");
    expect(tx.registration.update).not.toHaveBeenCalled();
  });
});
