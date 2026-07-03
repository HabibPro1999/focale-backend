import { describe, expect, it } from "vitest";
import { calculateApplicableAmount } from "./sponsorship-math";

describe("calculateApplicableAmount", () => {
  it("prefers calculatedBasePrice over baseAmount when covering base", () => {
    expect(
      calculateApplicableAmount(
        { coversBasePrice: true, coveredAccessIds: [], totalAmount: 1000 },
        {
          totalAmount: 1000,
          baseAmount: 300,
          accessTypeIds: [],
          priceBreakdown: { calculatedBasePrice: 200 },
        },
      ),
    ).toBe(200);
  });

  it("falls back to baseAmount when calculatedBasePrice is absent", () => {
    expect(
      calculateApplicableAmount(
        { coversBasePrice: true, coveredAccessIds: [], totalAmount: 1000 },
        {
          totalAmount: 1000,
          baseAmount: 300,
          accessTypeIds: [],
          priceBreakdown: {},
        },
      ),
    ).toBe(300);
  });

  it("only counts covered access ids present on the registration", () => {
    expect(
      calculateApplicableAmount(
        {
          coversBasePrice: false,
          coveredAccessIds: ["a", "b", "missing"],
          totalAmount: 1000,
        },
        {
          totalAmount: 1000,
          baseAmount: 0,
          accessTypeIds: ["a", "b"],
          priceBreakdown: {
            accessItems: [
              { accessId: "a", subtotal: 50 },
              { accessId: "b", subtotal: 70 },
            ],
          },
        },
      ),
    ).toBe(120);
  });

  it("caps at both the registration total and the sponsorship total", () => {
    expect(
      calculateApplicableAmount(
        { coversBasePrice: true, coveredAccessIds: [], totalAmount: 100 },
        {
          totalAmount: 250,
          baseAmount: 500,
          accessTypeIds: [],
          priceBreakdown: { calculatedBasePrice: 500 },
        },
      ),
    ).toBe(100);

    expect(
      calculateApplicableAmount(
        { coversBasePrice: true, coveredAccessIds: [], totalAmount: 500 },
        {
          totalAmount: 250,
          baseAmount: 500,
          accessTypeIds: [],
          priceBreakdown: { calculatedBasePrice: 500 },
        },
      ),
    ).toBe(250);
  });
});
