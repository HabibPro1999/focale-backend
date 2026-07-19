import { describe, it, expect } from "vitest";
import { SendCertificatesBodySchema } from "./certificates";

describe("SendCertificatesBodySchema", () => {
  it("accepts an empty body (legacy: send to all registrations)", () => {
    const result = SendCertificatesBodySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("still accepts the pre-existing registrationIds-only shape", () => {
    const result = SendCertificatesBodySchema.safeParse({
      registrationIds: ["11111111-1111-4111-8111-111111111111"],
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.abstractIds).toBeUndefined();
  });

  it("accepts an additive abstractIds array (H2)", () => {
    const result = SendCertificatesBodySchema.safeParse({
      abstractIds: ["22222222-2222-4222-8222-222222222222"],
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.abstractIds).toEqual([
      "22222222-2222-4222-8222-222222222222",
    ]);
  });

  it("accepts both registrationIds and abstractIds together", () => {
    const result = SendCertificatesBodySchema.safeParse({
      registrationIds: ["11111111-1111-4111-8111-111111111111"],
      abstractIds: ["22222222-2222-4222-8222-222222222222"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-uuid abstractIds entry", () => {
    const result = SendCertificatesBodySchema.safeParse({
      abstractIds: ["not-a-uuid"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields (strictObject)", () => {
    const result = SendCertificatesBodySchema.safeParse({
      abstractIds: [],
      extra: "nope",
    });
    expect(result.success).toBe(false);
  });
});
