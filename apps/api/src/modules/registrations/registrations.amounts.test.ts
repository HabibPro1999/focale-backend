import { describe, expect, it } from "vitest";
import type { PriceBreakdown } from "@app/contracts";
import { toAdminRegistration } from "./registrations.mappers";

const priceBreakdown: PriceBreakdown = { basePrice: 200.125, calculatedBasePrice: 100.125, appliedRules: [],
  accessItems: [], accessTotal: 0, subtotal: 100.125, sponsorships: [], sponsorshipTotal: 40.1, total: 60.025, currency: "TND" };

describe("registration row monetary fields", () => {
  it("exposes the saved catalogue price and exact outstanding balance without exposing credentials", () => {
    const result = toAdminRegistration({ id: "r", totalAmount: 100.125, paidAmount: 10.025,
      sponsorshipAmount: 40.1, currency: "TND", priceBreakdown, editToken: "secret", idempotencyKey: "private" });
    expect(result).toMatchObject({ amountDue: 50, catalogueBasePrice: 200.125,
      money: { currency: "TND", scale: 3, amountsMinor: { amountDue: 50000, catalogueBasePrice: 200125, totalAmount: 100125 } } });
    expect(result).not.toHaveProperty("editToken");
    expect(result).not.toHaveProperty("idempotencyKey");
  });
  it("floors the outstanding balance and does not invent missing historic catalogue prices", () => {
    const result = toAdminRegistration({ totalAmount: 10, paidAmount: 20, sponsorshipAmount: 0, currency: "TND",
      priceBreakdown: { ...priceBreakdown, basePrice: undefined } as unknown as PriceBreakdown });
    expect(result).toMatchObject({ amountDue: 0, catalogueBasePrice: null });
  });
});
