import { describe, expect, it } from "vitest";
import { MoneyAmountSchema } from "./money";
import { UpdateEventPricingSchema } from "./pricing";
import { UpdateEventAccessSchema } from "./access";

describe("compatible major amounts with currency fractions", () => {
  it("keeps integer prices and accepts fractional pricing/access amounts", () => {
    expect(UpdateEventPricingSchema.parse({ basePrice: 100 }).basePrice).toBe(100);
    expect(UpdateEventPricingSchema.parse({ basePrice: 100.125 }).basePrice).toBe(100.125);
    expect(UpdateEventAccessSchema.parse({ price: 1.25, companionPrice: 0.125 })).toMatchObject({ price: 1.25, companionPrice: 0.125 });
  });
  it.each([NaN, Infinity, -1, 0.00001, 1e15])("rejects invalid money %s", (amount) => {
    expect(MoneyAmountSchema.safeParse(amount).success).toBe(false);
  });
});
