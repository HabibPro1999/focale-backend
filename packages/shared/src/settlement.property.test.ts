import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PAYMENT_STATUSES, type SettlementStatus } from "./payment-status";
import {
  AUTO_TRANSITIONS,
  STICKY_SETTLEMENT_STATUSES,
  calculateSettlement,
  deriveSettlement,
  dropAccessItem,
  netBreakdown,
  type SettlementInput,
} from "./settlement";

// Property tests for the pure settlement logic (plan item 2.5).

const amount = fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 2_000 }), fc.integer({ min: 0, max: 10_000_000 }));
const status = fc.constantFrom<SettlementStatus>(...PAYMENT_STATUSES);
const date = fc.date({ min: new Date("2020-01-01T00:00:00.000Z"), max: new Date("2035-01-01T00:00:00.000Z"), noInvalidDate: true });

/** An amount at, below or above `target`, or 0: the boundaries the status rules turn on. */
function around(target: number): fc.Arbitrary<number> {
  return fc.oneof(
    fc.constant(0),
    fc.constant(target),
    fc.integer({ min: 0, max: target }),
    fc.integer({ min: target, max: target + 2_000 }),
  );
}

// Free registrations (gross 0) and exact coverage are generated on purpose.
const settlementInput: fc.Arbitrary<SettlementInput> = amount.chain((gross) =>
  around(gross).chain((sponsorship) =>
    fc.record({
      gross: fc.constant(gross),
      sponsorship: fc.constant(sponsorship),
      paid: around(Math.max(0, gross - sponsorship)),
      currentStatus: status,
      paidAt: fc.option(date, { nil: null }),
      now: date,
    }),
  ),
);

const isSticky = (value: SettlementStatus) => (STICKY_SETTLEMENT_STATUSES as readonly string[]).includes(value);

/**
 * The legacy linked-sponsorship recompute
 * (RegistrationsService.recalculateLinkedSponsorshipSettlement, status part),
 * copied here so the new function is checked against what runs today.
 */
function legacyRecalculate(input: SettlementInput): { status: SettlementStatus; paidAt: Date | null } {
  const current = input.currentStatus;
  if (current === "WAIVED" || current === "REFUNDED" || current === "PAID" || current === "VERIFYING") {
    return { status: current, paidAt: input.paidAt };
  }
  const sponsorshipAmount = Math.min(input.sponsorship, input.gross);
  const settlement = calculateSettlement({
    totalAmount: input.gross,
    paidAmount: input.paid,
    sponsorshipAmount,
  });
  let next: SettlementStatus;
  if (sponsorshipAmount >= input.gross && input.gross > 0) next = "SPONSORED";
  else if (settlement.isSettled && input.paid > 0) next = "PAID";
  else next = settlement.isPartiallyPaid ? "PARTIAL" : "PENDING";
  const paidAt = next === "PAID" || next === "SPONSORED" ? (input.paidAt ?? input.now) : null;
  return { status: next, paidAt };
}

describe("settlement properties", () => {
  it("netBreakdown: total = max(0, subtotal − sponsorship) and sponsorshipTotal = min(sponsorship, subtotal)", () => {
    fc.assert(
      fc.property(amount, amount, (subtotal, sponsorship) => {
        const breakdown = netBreakdown({ subtotal, currency: "TND" }, sponsorship);
        expect(breakdown.total).toBe(Math.max(0, subtotal - sponsorship));
        expect(breakdown.sponsorshipTotal).toBe(Math.min(sponsorship, subtotal));
        expect(breakdown.sponsorshipTotal + breakdown.total).toBe(subtotal);
        expect(breakdown.currency).toBe("TND");
      }),
    );
  });

  it("sticky statuses never change, nor does their paidAt", () => {
    fc.assert(
      fc.property(settlementInput, fc.constantFrom(...STICKY_SETTLEMENT_STATUSES), (input, sticky) => {
        const result = deriveSettlement({ ...input, currentStatus: sticky });
        expect(result.status).toBe(sticky);
        expect(result.paidAt).toBe(input.paidAt);
      }),
    );
  });

  it("is stable: deriving again from the result, even later, gives the same result", () => {
    fc.assert(
      fc.property(settlementInput, date, (input, later) => {
        const first = deriveSettlement(input);
        const second = deriveSettlement({ ...input, currentStatus: first.status, paidAt: first.paidAt, now: later });
        expect(second).toEqual(first);
      }),
    );
  });

  it("changes a status only along AUTO_TRANSITIONS", () => {
    fc.assert(
      fc.property(settlementInput, (input) => {
        const result = deriveSettlement(input);
        if (result.status !== input.currentStatus) {
          expect(AUTO_TRANSITIONS[input.currentStatus]).toContain(result.status);
        }
      }),
    );
  });

  it("a derived paidAt is null exactly for PENDING and PARTIAL, and an existing one is kept", () => {
    fc.assert(
      fc.property(settlementInput, (input) => {
        fc.pre(!isSticky(input.currentStatus));
        const result = deriveSettlement(input);
        expect(result.paidAt === null).toBe(result.status === "PENDING" || result.status === "PARTIAL");
        if (result.paidAt !== null) expect(result.paidAt).toBe(input.paidAt ?? input.now);
      }),
    );
  });

  it("amounts are consistent with the derived status", () => {
    fc.assert(
      fc.property(settlementInput, (input) => {
        const result = deriveSettlement(input);
        expect(result.sponsorship).toBe(Math.min(input.sponsorship, input.gross));
        expect(result.net).toBe(Math.max(0, input.gross - input.sponsorship));
        expect(result.due).toBe(Math.max(0, result.net - input.paid));
        if (isSticky(input.currentStatus)) return;
        if (result.status === "PAID" || result.status === "SPONSORED") expect(result.due).toBe(0);
        if (result.status === "SPONSORED") expect(result.gross).toBeGreaterThan(0);
        // Only a free, unpaid registration is PENDING with nothing due.
        if (result.status === "PARTIAL" || (result.status === "PENDING" && result.gross > 0)) {
          expect(result.due).toBeGreaterThan(0);
        }
      }),
    );
  });

  it("agrees with the legacy linked-sponsorship recompute", () => {
    fc.assert(
      fc.property(settlementInput, (input) => {
        const result = deriveSettlement(input);
        expect({ status: result.status, paidAt: result.paidAt }).toEqual(legacyRecalculate(input));
      }),
    );
  });

  it("dropAccessItem removes exactly the dropped item's amount and keeps the net rule", () => {
    const item = fc.record({
      accessId: fc.constantFrom("a", "b", "c", "d"),
      name: fc.constantFrom("Gala", "Workshop"),
      unitPrice: amount,
      quantity: fc.integer({ min: 1, max: 5 }),
      subtotal: amount,
    });
    fc.assert(
      fc.property(amount, fc.array(item, { maxLength: 6 }), fc.constantFrom("a", "b", "c", "d"), amount, (base, items, accessId, sponsorship) => {
        const accessTotal = items.reduce((sum, line) => sum + line.subtotal, 0);
        const breakdown = { calculatedBasePrice: base, accessItems: items, accessTotal, subtotal: base + accessTotal };
        const result = dropAccessItem(breakdown, accessId, sponsorship, "deactivated");
        const removed = items.filter((line) => line.accessId === accessId);
        if (removed.length === 0) {
          expect(result).toBeNull();
          return;
        }
        expect(result).not.toBeNull();
        const removedTotal = removed.reduce((sum, line) => sum + line.subtotal, 0);
        expect(result!.gross).toBe(breakdown.subtotal - removedTotal);
        expect(result!.breakdown.accessItems.every((line) => line.accessId !== accessId)).toBe(true);
        expect(result!.breakdown.droppedAccessItems).toEqual([{ ...removed[0], reason: "deactivated" }]);
        expect(result!.breakdown.total).toBe(Math.max(0, result!.gross - sponsorship));
        expect(result!.sponsorship).toBe(Math.min(sponsorship, result!.gross));
      }),
    );
  });
});
