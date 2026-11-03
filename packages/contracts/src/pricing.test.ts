import { describe, expect, it } from "vitest";
import { ErrorCodes } from "./errors";
import { UpdateEventPricingSchema } from "./pricing";

describe("UpdateEventPricingSchema free-event flags", () => {
  it.each([{ isFree: true }, { isFree: false }, { autoAccept: false }, { isFree: true, autoAccept: true }])(
    "accepts %o as an update on its own",
    (body) => {
      expect(UpdateEventPricingSchema.parse(body)).toEqual(body);
    },
  );

  it("rejects non-boolean flags and still requires one field", () => {
    expect(UpdateEventPricingSchema.safeParse({ isFree: "yes" }).success).toBe(false);
    expect(UpdateEventPricingSchema.safeParse({ autoAccept: 1 }).success).toBe(false);
    expect(UpdateEventPricingSchema.safeParse({}).success).toBe(false);
  });

  it("names the auto-accept guard PRC_6009", () => {
    expect(ErrorCodes.AUTO_ACCEPT_REQUIRES_FREE_EVENT).toBe("PRC_6009");
  });
});
