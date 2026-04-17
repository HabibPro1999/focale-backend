import { describe, it, expect } from "vitest";
import { RegistrantSearchResultSchema } from "@modules/registrations/registrations.schema.js";

// ============================================================================
// RegistrantSearchResultSchema — PII fields must not be present
// ============================================================================

describe("RegistrantSearchResultSchema — PII strip", () => {
  const validResult = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    email: "doctor@example.com",
    firstName: "Alice",
    lastName: "Martin",
    paymentStatus: "PENDING" as const,
    totalAmount: 300,
    baseAmount: 300,
    sponsorshipAmount: 0,
    accessTypeIds: [],
    coveredAccessIds: [],
    isBasePriceCovered: false,
  };

  it("accepts a valid result without phone or formData", () => {
    const result = RegistrantSearchResultSchema.safeParse(validResult);
    expect(result.success).toBe(true);
  });

  it("response shape does not contain phone key", () => {
    const result = RegistrantSearchResultSchema.safeParse(validResult);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data)).not.toContain("phone");
    }
  });

  it("response shape does not contain formData key", () => {
    const result = RegistrantSearchResultSchema.safeParse(validResult);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data)).not.toContain("formData");
    }
  });

  it("extra phone field is stripped (z.object strips by default)", () => {
    const withPhone = { ...validResult, phone: "+216 55 123 456" };
    const result = RegistrantSearchResultSchema.safeParse(withPhone);
    expect(result.success).toBe(true);
    if (result.success) {
      // z.object (non-strict) strips unknown keys
      expect(Object.keys(result.data)).not.toContain("phone");
    }
  });

  it("extra formData field is stripped", () => {
    const withFormData = { ...validResult, formData: { specialty: "cardiology" } };
    const result = RegistrantSearchResultSchema.safeParse(withFormData);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data)).not.toContain("formData");
    }
  });

  it("required fields are still present after parse", () => {
    const result = RegistrantSearchResultSchema.safeParse(validResult);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe(validResult.id);
      expect(result.data.email).toBe(validResult.email);
      expect(result.data.paymentStatus).toBe("PENDING");
      expect(result.data.isBasePriceCovered).toBe(false);
    }
  });
});
