import { describe, expect, it } from "vitest";
import {
  AdminEditRegistrationSchema,
  UpdatePaymentSchema,
  UpdateRegistrationSchema,
} from "./registrations.schema.js";

describe("registration payment proof schemas", () => {
  it("accepts private storage keys for payment proof locations", () => {
    const paymentProofUrl = "event-1/registration-1/proof.webp";

    expect(
      UpdatePaymentSchema.parse({
        paymentStatus: "VERIFYING",
        paymentProofUrl,
      }).paymentProofUrl,
    ).toBe(paymentProofUrl);

    expect(
      UpdateRegistrationSchema.parse({
        paymentProofUrl,
      }).paymentProofUrl,
    ).toBe(paymentProofUrl);

    expect(
      AdminEditRegistrationSchema.parse({
        paymentProofUrl,
      }).paymentProofUrl,
    ).toBe(paymentProofUrl);
  });

  it("still accepts legacy public URLs", () => {
    const paymentProofUrl = "https://storage.example.com/proof.webp";

    expect(
      UpdatePaymentSchema.parse({
        paymentStatus: "VERIFYING",
        paymentProofUrl,
      }).paymentProofUrl,
    ).toBe(paymentProofUrl);
  });

  it("rejects empty payment proof locations", () => {
    expect(() =>
      UpdateRegistrationSchema.parse({ paymentProofUrl: "" }),
    ).toThrow();
  });
});
