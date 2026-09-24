import { describe, expect, it } from "vitest";
import { FULLY_SETTLED_STATUSES, isFullySettled } from "./payment-status";

describe("isFullySettled", () => {
  it.each(["PAID", "SPONSORED", "WAIVED"])("is true for %s", (status) => {
    expect(isFullySettled(status)).toBe(true);
  });

  it.each(["PENDING", "VERIFYING", "PARTIAL", "REFUNDED", "paid", "", null, undefined])(
    "is false for %s",
    (status) => {
      expect(isFullySettled(status)).toBe(false);
    },
  );

  it("lists exactly the fully settled statuses", () => {
    expect(FULLY_SETTLED_STATUSES).toEqual(["PAID", "SPONSORED", "WAIVED"]);
  });
});
