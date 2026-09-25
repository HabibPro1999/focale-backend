import { describe, expect, it } from "vitest";
import { ErrorCodes } from "@app/contracts";
import { PAYMENT_STATUSES } from "@app/shared";
import {
  ADMIN_OVERRIDE_TRANSITIONS,
  validateAdminPaymentOverride,
  validatePaymentTransition,
} from "./payment-transitions";

const pairs = PAYMENT_STATUSES.flatMap((from) => PAYMENT_STATUSES.map((to) => [from, to] as const));

describe("validatePaymentTransition", () => {
  it("allows VERIFYING → PARTIAL (plan 2.6) and still refuses leaving PAID except to REFUNDED", () => {
    expect(() => validatePaymentTransition("VERIFYING", "PARTIAL")).not.toThrow();
    expect(() => validatePaymentTransition("PAID", "REFUNDED")).not.toThrow();
    expect(() => validatePaymentTransition("PAID", "VERIFYING")).toThrow(
      expect.objectContaining({ code: ErrorCodes.INVALID_PAYMENT_TRANSITION }),
    );
  });

  it("treats the same status as a no-op", () => {
    for (const status of PAYMENT_STATUSES) expect(() => validatePaymentTransition(status, status)).not.toThrow();
  });
});

describe("validateAdminPaymentOverride", () => {
  it("lists every status, and nothing leaves REFUNDED", () => {
    expect(Object.keys(ADMIN_OVERRIDE_TRANSITIONS).sort()).toEqual([...PAYMENT_STATUSES].sort());
    expect(ADMIN_OVERRIDE_TRANSITIONS.REFUNDED).toEqual([]);
  });

  it.each(pairs)("%s → %s", (from, to) => {
    const run = () => validateAdminPaymentOverride(from, to);
    if (from === to || from !== "REFUNDED") {
      expect(run).not.toThrow();
    } else {
      expect(run).toThrow(
        expect.objectContaining({ code: ErrorCodes.INVALID_PAYMENT_TRANSITION, statusCode: 400 }),
      );
    }
  });
});
