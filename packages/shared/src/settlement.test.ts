import { describe, expect, it } from "vitest";
import {
  AUTO_TRANSITIONS,
  calculateDiscountAmount,
  calculateSettlement,
  deriveSettlement,
  dropAccessItem,
  netBreakdown,
  paidAccessQuantities,
  type SettlementInput,
} from "./settlement";
import { PAYMENT_STATUSES, type SettlementStatus } from "./payment-status";

describe("calculateSettlement", () => {
  it("marks zero-total registrations settled without sponsorship", () => {
    expect(
      calculateSettlement({
        totalAmount: 0,
        paidAmount: 0,
        sponsorshipAmount: 0,
      }),
    ).toEqual({
      amountDue: 0,
      netAmount: 0,
      isSettled: true,
      isPartiallyPaid: false,
    });
  });

  it("tracks partial coverage", () => {
    expect(
      calculateSettlement({
        totalAmount: 300,
        paidAmount: 100,
        sponsorshipAmount: 50,
      }),
    ).toMatchObject({
      amountDue: 150,
      netAmount: 250,
      isSettled: false,
      isPartiallyPaid: true,
    });
  });

  it("caps amount due at zero for overpayment", () => {
    expect(
      calculateSettlement({
        totalAmount: 300,
        paidAmount: 400,
        sponsorshipAmount: 0,
      }),
    ).toMatchObject({
      amountDue: 0,
      isSettled: true,
      isPartiallyPaid: false,
    });
  });
});

const NOW = new Date("2027-05-01T10:00:00.000Z");
const EARLIER = new Date("2027-04-01T10:00:00.000Z");

function derive(overrides: Partial<SettlementInput>) {
  return deriveSettlement({
    gross: 1000,
    sponsorship: 0,
    paid: 0,
    currentStatus: "PENDING",
    paidAt: null,
    now: NOW,
    ...overrides,
  });
}

describe("deriveSettlement", () => {
  it.each<[string, Partial<SettlementInput>, SettlementStatus, Date | null]>([
    ["nothing covered", {}, "PENDING", null],
    ["part paid", { paid: 400 }, "PARTIAL", null],
    ["part sponsored", { sponsorship: 300 }, "PARTIAL", null],
    ["sponsored and paid in full", { sponsorship: 300, paid: 700 }, "PAID", NOW],
    ["paid in full", { paid: 1000 }, "PAID", NOW],
    ["overpaid", { paid: 1200 }, "PAID", NOW],
    ["fully sponsored", { sponsorship: 1000 }, "SPONSORED", NOW],
    ["sponsorship above the price", { sponsorship: 1500 }, "SPONSORED", NOW],
    ["fully sponsored and also paid", { sponsorship: 1000, paid: 200 }, "SPONSORED", NOW],
    // Legacy: a free registration stays PENDING; nothing was paid or sponsored.
    ["free registration", { gross: 0 }, "PENDING", null],
    ["free registration with a stale sponsorship", { gross: 0, sponsorship: 200 }, "PENDING", null],
    ["free registration paid anyway", { gross: 0, paid: 100 }, "PAID", NOW],
  ])("derives %s", (_, overrides, status, paidAt) => {
    const result = derive(overrides);
    expect(result.status).toBe(status);
    expect(result.paidAt).toEqual(paidAt);
  });

  it("recomputes SPONSORED, PARTIAL and PENDING from the amounts", () => {
    expect(derive({ currentStatus: "SPONSORED", paidAt: EARLIER, sponsorship: 300 })).toMatchObject({
      status: "PARTIAL",
      paidAt: null,
    });
    expect(derive({ currentStatus: "PARTIAL", sponsorship: 0 })).toMatchObject({ status: "PENDING" });
    expect(derive({ currentStatus: "PARTIAL", sponsorship: 1000 })).toMatchObject({ status: "SPONSORED", paidAt: NOW });
  });

  it("keeps an existing paidAt when the result is PAID or SPONSORED", () => {
    expect(derive({ currentStatus: "SPONSORED", paidAt: EARLIER, sponsorship: 1000 }).paidAt).toBe(EARLIER);
    expect(derive({ currentStatus: "SPONSORED", paidAt: EARLIER, sponsorship: 500, paid: 500 })).toMatchObject({
      status: "PAID",
      paidAt: EARLIER,
    });
  });

  it.each(["PAID", "WAIVED", "REFUNDED", "VERIFYING"] as const)("never changes %s", (currentStatus) => {
    for (const paidAt of [null, EARLIER]) {
      for (const amounts of [{}, { paid: 1000 }, { sponsorship: 1000 }, { paid: 100 }, { gross: 0 }]) {
        const result = derive({ currentStatus, paidAt, ...amounts });
        expect(result.status).toBe(currentStatus);
        expect(result.paidAt).toBe(paidAt);
      }
    }
  });

  it("reports the amounts with the sponsorship capped at gross", () => {
    expect(derive({ sponsorship: 300, paid: 200 })).toMatchObject({ gross: 1000, sponsorship: 300, net: 700, due: 500 });
    expect(derive({ sponsorship: 1500, paid: 0 })).toMatchObject({ sponsorship: 1000, net: 0, due: 0 });
    expect(derive({ paid: 1300 })).toMatchObject({ net: 1000, due: 0 });
  });

  it.each([
    ["gross", { gross: -1 }],
    ["sponsorship", { sponsorship: 1.5 }],
    ["paid", { paid: Number.NaN }],
  ])("rejects an invalid %s amount", (name, overrides) => {
    expect(() => derive(overrides)).toThrow(new RegExp(`^${name} must be a non-negative integer amount`));
  });
});

describe("AUTO_TRANSITIONS", () => {
  it("lists every payment status, and nothing for the sticky ones", () => {
    expect(Object.keys(AUTO_TRANSITIONS).sort()).toEqual([...PAYMENT_STATUSES].sort());
    for (const sticky of ["PAID", "WAIVED", "REFUNDED", "VERIFYING"] as const) {
      expect(AUTO_TRANSITIONS[sticky]).toEqual([]);
    }
    for (const targets of Object.values(AUTO_TRANSITIONS)) {
      expect(targets).not.toContain("VERIFYING");
      expect(targets).not.toContain("WAIVED");
      expect(targets).not.toContain("REFUNDED");
    }
  });
});

describe("netBreakdown", () => {
  it("caps the sponsorship at the subtotal and keeps every other field", () => {
    const breakdown = { subtotal: 900, accessTotal: 400, currency: "TND", sponsorshipTotal: 0, total: 900 };
    expect(netBreakdown(breakdown, 300)).toEqual({ ...breakdown, sponsorshipTotal: 300, total: 600 });
    expect(netBreakdown(breakdown, 1200)).toEqual({ ...breakdown, sponsorshipTotal: 900, total: 0 });
  });
});

describe("dropAccessItem", () => {
  const breakdown = {
    basePrice: 500,
    calculatedBasePrice: 450,
    accessItems: [
      { accessId: "gala", name: "Gala", unitPrice: 200, quantity: 1, subtotal: 200 },
      { accessId: "workshop", name: "Workshop", unitPrice: 150, quantity: 2, subtotal: 300 },
    ],
    accessTotal: 500,
    subtotal: 950,
    sponsorshipTotal: 450,
    total: 500,
    currency: "TND",
    droppedAccessItems: [],
  };

  it("removes the item and recomputes the totals from what remains", () => {
    const result = dropAccessItem(breakdown, "workshop", 450, "capacity_reached");
    expect(result).toEqual({
      breakdown: {
        ...breakdown,
        accessItems: [breakdown.accessItems[0]],
        accessTotal: 200,
        subtotal: 650,
        sponsorshipTotal: 450,
        total: 200,
        droppedAccessItems: [{ ...breakdown.accessItems[1], reason: "capacity_reached" }],
      },
      dropped: breakdown.accessItems[1],
      gross: 650,
      accessAmount: 200,
      sponsorship: 450,
    });
  });

  it("caps the sponsorship at the new subtotal", () => {
    const result = dropAccessItem(breakdown, "workshop", 900, "deactivated");
    expect(result).toMatchObject({ gross: 650, sponsorship: 650, breakdown: { sponsorshipTotal: 650, total: 0 } });
  });

  it("returns null when the breakdown has no such item", () => {
    expect(dropAccessItem(breakdown, "missing", 0, "deactivated")).toBeNull();
  });
});

describe("paidAccessQuantities", () => {
  const breakdown = {
    accessItems: [
      { accessId: "gala", quantity: 1, subtotal: 200 },
      { accessId: "workshop", quantity: 2, subtotal: 300 },
      { accessId: "gala", quantity: 1, subtotal: 200 },
    ],
  };

  it.each(["PAID", "SPONSORED", "WAIVED"])("counts every item when %s", (status) => {
    expect(paidAccessQuantities(status, breakdown)).toEqual(new Map([["gala", 2], ["workshop", 2]]));
  });

  it("counts only sponsorship-covered items when PARTIAL", () => {
    expect(paidAccessQuantities("PARTIAL", breakdown, new Set(["workshop"]))).toEqual(new Map([["workshop", 2]]));
    expect(paidAccessQuantities("PARTIAL", breakdown)).toEqual(new Map());
  });

  it.each(["PENDING", "VERIFYING", "REFUNDED"])("counts nothing when %s", (status) => {
    expect(paidAccessQuantities(status, breakdown, new Set(["gala"]))).toEqual(new Map());
  });
});

describe("calculateDiscountAmount", () => {
  it("adds up the negative rule effects as a positive amount", () => {
    expect(calculateDiscountAmount([{ effect: -100 }, { effect: 50 }, { effect: -25 }])).toBe(125);
    expect(calculateDiscountAmount([{ effect: 80 }])).toBe(0);
    expect(calculateDiscountAmount([])).toBe(0);
  });
});
