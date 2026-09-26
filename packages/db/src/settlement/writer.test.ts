import { describe, expect, it, vi } from "vitest";
import type { PriceBreakdown } from "@app/contracts";
import type { DbExecutor } from "../client";
import {
  SETTLEMENT_COLUMNS,
  SettlementInvariantError,
  applyRegistrationSettlement,
  settlementInvariantViolations,
  type SettlementColumn,
  type WrittenSettlementState,
} from "./writer";

const breakdown = (over: Partial<PriceBreakdown> = {}): PriceBreakdown => ({
  basePrice: 300,
  appliedRules: [],
  calculatedBasePrice: 300,
  accessItems: [{ accessId: "gala", name: "Gala", unitPrice: 200, quantity: 1, subtotal: 200 }],
  accessTotal: 200,
  subtotal: 500,
  sponsorships: [],
  sponsorshipTotal: 100,
  total: 400,
  currency: "TND",
  ...over,
});
const row = (over: Partial<WrittenSettlementState> = {}): WrittenSettlementState => ({
  paidAmount: 0,
  totalAmount: 500,
  sponsorshipAmount: 100,
  priceBreakdown: breakdown(),
  ...over,
});
const wrote = (...columns: SettlementColumn[]) => new Set<SettlementColumn>(columns);

describe("settlementInvariantViolations", () => {
  it("accepts a consistent state", () => {
    expect(settlementInvariantViolations(row({ paidAmount: 400 }), wrote(...SETTLEMENT_COLUMNS))).toEqual([]);
  });

  it("checks sponsorship ≤ total only when either is written", () => {
    const bad = row({ sponsorshipAmount: 600, priceBreakdown: null });
    expect(settlementInvariantViolations(bad, wrote("paymentStatus"))).toEqual([]);
    expect(settlementInvariantViolations(bad, wrote("totalAmount"))).toEqual([
      "sponsorship_amount 600 exceeds total_amount 500",
    ]);
  });

  it.each([
    ["sponsorshipTotal differs from the column", { sponsorshipTotal: 50, total: 450 }, /differs from sponsorship_amount/],
    ["total is not subtotal − sponsorshipTotal", { total: 450 }, /total 450 is not subtotal − sponsorshipTotal/],
    ["subtotal is not base + access", { subtotal: 600, total: 500 }, /subtotal 600 is not calculatedBasePrice \+ accessTotal/],
    ["accessTotal is not the sum of the items", { accessTotal: 150, subtotal: 450, total: 350 }, /accessTotal 150 is not the sum/],
    ["an amount is negative", { calculatedBasePrice: -1 }, /calculatedBasePrice not a non-negative integer/],
  ])("rejects a written breakdown whose %s", (_, over, message) => {
    const violations = settlementInvariantViolations(row({ priceBreakdown: breakdown(over) }), wrote("priceBreakdown"));
    expect(violations.join("\n")).toMatch(message);
  });

  it("rejects a written breakdown whose subtotal exceeds total_amount", () => {
    expect(settlementInvariantViolations(row({ totalAmount: 400 }), wrote("priceBreakdown"))).toContain(
      "price_breakdown subtotal 500 exceeds total_amount 400",
    );
  });

  it("checks paid ≤ net only when paid is written", () => {
    const overpaid = row({ paidAmount: 450 });
    expect(settlementInvariantViolations(overpaid, wrote("paymentStatus"))).toEqual([]);
    expect(settlementInvariantViolations(overpaid, wrote("paidAmount"))).toEqual(["paid_amount 450 exceeds the net 400"]);
  });
});

describe("applyRegistrationSettlement outside the database", () => {
  const tx = { rollback: vi.fn(), update: vi.fn() } as unknown as DbExecutor;

  it("refuses to run outside a transaction", async () => {
    await expect(
      applyRegistrationSettlement({ update: vi.fn() } as unknown as DbExecutor, {
        registrationId: "r",
        settlement: { paymentStatus: "PAID" },
      }),
    ).rejects.toThrow(/inside a transaction/);
  });

  it("refuses money columns passed as fields", async () => {
    await expect(
      applyRegistrationSettlement(tx, {
        registrationId: "r",
        settlement: {},
        fields: { paidAmount: 5 } as never,
      }),
    ).rejects.toThrow(/Money columns are written only through the settlement: paidAmount/);
  });

  it("refuses a negative or fractional amount before writing", async () => {
    const error = await applyRegistrationSettlement(tx, {
      registrationId: "r",
      settlement: { paidAmount: -1, totalAmount: 2.5 },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SettlementInvariantError);
    expect((error as SettlementInvariantError).violations).toEqual([
      "paidAmount -1 is not a non-negative integer",
      "totalAmount 2.5 is not a non-negative integer",
    ]);
    expect((tx as unknown as { update: ReturnType<typeof vi.fn> }).update).not.toHaveBeenCalled();
  });

  it("refuses an empty write, as drizzle's empty SET did before the writer", async () => {
    await expect(applyRegistrationSettlement(tx, { registrationId: "r", settlement: {}, fields: {} })).rejects.toThrow(
      /Nothing to write/,
    );
  });
});
