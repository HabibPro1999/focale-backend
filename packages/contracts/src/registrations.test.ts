import { describe, it, expect } from "vitest";
import {
  UpdatePaymentSchema,
  UpdateRegistrationSchema,
  AdminEditRegistrationSchema,
  SelectPaymentMethodSchema,
} from "./registrations";

// Ported from legacy registrations.schema.test.ts — paymentProofUrl accepts both
// bare storage keys and full public URLs, and rejects the empty string.
describe("paymentProofUrl acceptance", () => {
  const bareKey = "event-1/registration-1/proof.webp";
  const fullUrl = "https://storage.example.com/proof.webp";

  it("UpdatePaymentSchema accepts a bare storage key", () => {
    const r = UpdatePaymentSchema.safeParse({
      paymentStatus: "PAID",
      paymentProofUrl: bareKey,
    });
    expect(r.success).toBe(true);
  });

  it("UpdatePaymentSchema accepts a full URL", () => {
    const r = UpdatePaymentSchema.safeParse({
      paymentStatus: "PAID",
      paymentProofUrl: fullUrl,
    });
    expect(r.success).toBe(true);
  });

  it("UpdateRegistrationSchema accepts a bare storage key", () => {
    expect(
      UpdateRegistrationSchema.safeParse({ paymentProofUrl: bareKey }).success,
    ).toBe(true);
  });

  it("AdminEditRegistrationSchema accepts a bare storage key", () => {
    expect(
      AdminEditRegistrationSchema.safeParse({ paymentProofUrl: bareKey }).success,
    ).toBe(true);
  });

  it("rejects an empty-string paymentProofUrl", () => {
    expect(
      UpdatePaymentSchema.safeParse({
        paymentStatus: "PAID",
        paymentProofUrl: "",
      }).success,
    ).toBe(false);
    expect(
      UpdateRegistrationSchema.safeParse({ paymentProofUrl: "" }).success,
    ).toBe(false);
  });
});

describe("lab-name refinement (SelectPaymentMethodSchema)", () => {
  it("requires labName when paymentMethod is LAB_SPONSORSHIP", () => {
    expect(
      SelectPaymentMethodSchema.safeParse({ paymentMethod: "LAB_SPONSORSHIP" })
        .success,
    ).toBe(false);
    expect(
      SelectPaymentMethodSchema.safeParse({
        paymentMethod: "LAB_SPONSORSHIP",
        labName: "Acme Labs",
      }).success,
    ).toBe(true);
    expect(
      SelectPaymentMethodSchema.safeParse({ paymentMethod: "CASH" }).success,
    ).toBe(true);
  });

  it("AdminEditRegistrationSchema does NOT enforce requireLabName", () => {
    // Legacy parity: AdminEdit only requires 'at least one field'.
    expect(
      AdminEditRegistrationSchema.safeParse({ paymentMethod: "LAB_SPONSORSHIP" })
        .success,
    ).toBe(true);
  });
});
