import { describe, expect, it } from "vitest";
import { CreateSponsorshipBatchSchema, RegistrantSearchQuerySchema } from "./sponsorships";

const base = {
  sponsor: {
    labName: "Acme Labs",
    contactName: "Jane Doe",
    email: "jane@acme.test",
  },
  beneficiaries: [
    {
      name: "Ben Eficiary",
      email: "ben@acme.test",
      coversBasePrice: true,
    },
  ],
};

describe("CreateSponsorshipBatchSchema idempotencyKey (legacy parity)", () => {
  it("accepts a body with an idempotencyKey (form app always sends it)", () => {
    const parsed = CreateSponsorshipBatchSchema.safeParse({
      ...base,
      idempotencyKey: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a body without an idempotencyKey", () => {
    expect(CreateSponsorshipBatchSchema.safeParse(base).success).toBe(true);
  });

  it("still rejects unknown keys (strict object intact)", () => {
    expect(
      CreateSponsorshipBatchSchema.safeParse({ ...base, bogus: true }).success,
    ).toBe(false);
  });
});

describe("RegistrantSearchQuerySchema (anonymous sponsor search)", () => {
  it("rejects fewer than 3 characters after trimming", () => {
    for (const query of ["", "ab", "  ab  ", "   "]) {
      expect(RegistrantSearchQuerySchema.safeParse({ query }).success).toBe(false);
    }
  });

  it("accepts 3+ characters and trims the query", () => {
    const parsed = RegistrantSearchQuerySchema.parse({ query: "  abc ", unpaidOnly: "true" });
    expect(parsed).toEqual({ query: "abc", unpaidOnly: "true" });
  });
});
