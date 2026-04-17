import { describe, it, expect } from "vitest";
import {
  BeneficiaryInputSchema,
  LinkedBeneficiaryInputSchema,
} from "@modules/sponsorships/sponsorships.schema.js";
import { faker } from "@faker-js/faker";

// ============================================================================
// Fix 3 — coveredAccessIds .max(50) enforcement
// ============================================================================

describe("BeneficiaryInputSchema — coveredAccessIds max(50)", () => {
  it("accepts exactly 50 access IDs", () => {
    const ids = Array.from({ length: 50 }, () => faker.string.uuid());
    const result = BeneficiaryInputSchema.safeParse({
      name: "Doctor Name",
      email: "doc@example.com",
      coversBasePrice: false,
      coveredAccessIds: ids,
    });
    expect(result.success).toBe(true);
  });

  it("rejects 51 access IDs", () => {
    const ids = Array.from({ length: 51 }, () => faker.string.uuid());
    const result = BeneficiaryInputSchema.safeParse({
      name: "Doctor Name",
      email: "doc@example.com",
      coversBasePrice: false,
      coveredAccessIds: ids,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(" ");
      expect(messages).toMatch(/too_big|Array must contain at most 50|have <=50/i);
    }
  });

  it("accepts 0 access IDs when coversBasePrice is true", () => {
    const result = BeneficiaryInputSchema.safeParse({
      name: "Doctor Name",
      email: "doc@example.com",
      coversBasePrice: true,
      coveredAccessIds: [],
    });
    expect(result.success).toBe(true);
  });
});

describe("LinkedBeneficiaryInputSchema — coveredAccessIds max(50)", () => {
  it("accepts exactly 50 access IDs", () => {
    const ids = Array.from({ length: 50 }, () => faker.string.uuid());
    const result = LinkedBeneficiaryInputSchema.safeParse({
      registrationId: faker.string.uuid(),
      coversBasePrice: false,
      coveredAccessIds: ids,
    });
    expect(result.success).toBe(true);
  });

  it("rejects 51 access IDs", () => {
    const ids = Array.from({ length: 51 }, () => faker.string.uuid());
    const result = LinkedBeneficiaryInputSchema.safeParse({
      registrationId: faker.string.uuid(),
      coversBasePrice: false,
      coveredAccessIds: ids,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(" ");
      expect(messages).toMatch(/too_big|Array must contain at most 50|have <=50/i);
    }
  });
});
