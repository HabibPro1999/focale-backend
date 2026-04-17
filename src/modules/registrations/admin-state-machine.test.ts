import { describe, it, expect } from "vitest";
import { AdminEditRegistrationSchema } from "@modules/registrations/registrations.schema.js";
import { validatePaymentTransition } from "@modules/registrations/registration-payment.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";

// ============================================================================
// AdminEditRegistrationSchema — force + transitionReason validation
// ============================================================================

describe("AdminEditRegistrationSchema — force/transitionReason", () => {
  it("accepts a valid update without force", () => {
    const result = AdminEditRegistrationSchema.safeParse({ note: "hello" });
    expect(result.success).toBe(true);
  });

  it("rejects force=true without transitionReason", () => {
    const result = AdminEditRegistrationSchema.safeParse({
      paymentStatus: "PENDING",
      force: true,
      // transitionReason missing
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("transitionReason");
    }
  });

  it("rejects force=true with transitionReason shorter than 10 chars", () => {
    const result = AdminEditRegistrationSchema.safeParse({
      paymentStatus: "PENDING",
      force: true,
      transitionReason: "short",
    });
    expect(result.success).toBe(false);
  });

  it("accepts force=true with valid transitionReason (>=10 chars)", () => {
    const result = AdminEditRegistrationSchema.safeParse({
      paymentStatus: "PENDING",
      force: true,
      transitionReason: "This is a valid reason for forcing the transition",
    });
    expect(result.success).toBe(true);
  });

  it("does not require transitionReason when force is omitted", () => {
    const result = AdminEditRegistrationSchema.safeParse({
      paymentStatus: "PAID",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an object where all values are undefined (at-least-one guard)", () => {
    const result = AdminEditRegistrationSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// validatePaymentTransition — state machine
// ============================================================================

describe("validatePaymentTransition", () => {
  it("valid transition: PENDING → PAID — no throw", () => {
    expect(() => validatePaymentTransition("PENDING", "PAID")).not.toThrow();
  });

  it("valid transition: PAID → REFUNDED — no throw", () => {
    expect(() => validatePaymentTransition("PAID", "REFUNDED")).not.toThrow();
  });

  it("invalid transition: REFUNDED → PENDING — throws INVALID_PAYMENT_TRANSITION", () => {
    expect(() => validatePaymentTransition("REFUNDED", "PENDING")).toThrow(AppError);
    try {
      validatePaymentTransition("REFUNDED", "PENDING");
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCodes.INVALID_PAYMENT_TRANSITION);
    }
  });

  it("invalid transition: REFUNDED → PAID — throws", () => {
    expect(() => validatePaymentTransition("REFUNDED", "PAID")).toThrow(AppError);
  });

  it("invalid transition: PAID → PENDING — throws", () => {
    expect(() => validatePaymentTransition("PAID", "PENDING")).toThrow(AppError);
  });

  it("same status (no-op): does NOT throw", () => {
    expect(() => validatePaymentTransition("PAID", "PAID")).not.toThrow();
    expect(() => validatePaymentTransition("REFUNDED", "REFUNDED")).not.toThrow();
  });

  it("PARTIAL → PAID is valid", () => {
    expect(() => validatePaymentTransition("PARTIAL", "PAID")).not.toThrow();
  });

  it("SPONSORED → PARTIAL is valid (unlink scenario)", () => {
    expect(() => validatePaymentTransition("SPONSORED", "PARTIAL")).not.toThrow();
  });
});
