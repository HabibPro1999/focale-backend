import { describe, expect, it } from "vitest";
import { moneySnapshot, multiplyMoney, subtractMoney, sumMoney, toMinorUnits } from "./money";
import { calculateSettlement, deriveSettlement, dropAccessItem } from "./settlement";

describe("exact money with compatible major-unit fields", () => {
  it("adds/subtracts fractions without floating point drift", () => {
    expect(sumMoney(0.1, 0.2)).toBe(0.3);
    expect(subtractMoney(0.3, 0.1)).toBe(0.2);
    expect(multiplyMoney(1.125, 3)).toBe(3.375);
    expect(calculateSettlement({ totalAmount: 0.3, paidAmount: 0.1, sponsorshipAmount: 0.2 }).amountDue).toBe(0);
  });
  it("exposes explicit currency scales without reinterpreting old values", () => {
    expect(moneySnapshot("TND", { price: 100, adjustment: -0.125 })).toEqual({ currency: "TND", scale: 3, amountsMinor: { price: 100000, adjustment: -125 } });
    expect(toMinorUnits(1.25, "EUR")).toBe(125);
    expect(toMinorUnits(100, "JPY")).toBe(100);
    expect(() => toMinorUnits(0.001, "EUR")).toThrow(RangeError);
    expect(() => sumMoney(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
  });
  it("settles fractional payments exactly", () => {
    expect(deriveSettlement({ gross: 0.3, sponsorship: 0.2, paid: 0.1, currentStatus: "PARTIAL", paidAt: null, now: new Date(0) }))
      .toMatchObject({ status: "PAID", net: 0.1, due: 0 });
  });
  it("keeps option charges when an access item is dropped", () => {
    const result = dropAccessItem({ calculatedBasePrice: 10, optionModifiersTotal: 2.125,
      accessItems: [{ accessId: "a", name: "A", quantity: 1, unitPrice: 1, subtotal: 1 }] }, "a", 10, "deactivated");
    expect(result).toMatchObject({ gross: 12.125, sponsorship: 10, breakdown: { subtotal: 12.125, total: 2.125 } });
    expect(dropAccessItem({ calculatedBasePrice: 10, optionModifiersTotal: 2.125,
      accessItems: [{ accessId: "a", name: "A", quantity: 1, unitPrice: 5, subtotal: 5 }] }, "a", 15, "deactivated"))
      .toMatchObject({ sponsorship: 10, breakdown: { total: 2.125 } });
  });
});
