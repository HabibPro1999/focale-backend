import { describe, it, expect } from "vitest";
import {
  SendCertificatesBodySchema,
  CreateCertificateTemplateSchema,
  UpdateCertificateTemplateSchema,
} from "./certificates";

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

// H2: certificate template scope + allowed abstract final types.
describe("CreateCertificateTemplateSchema — scope + allowedAbstractFinalTypes (H2)", () => {
  it("defaults scope to BOTH and allowedAbstractFinalTypes to [] when omitted", () => {
    const result = CreateCertificateTemplateSchema.safeParse({ name: "Cert" });
    expect(result.success).toBe(true);
    expect(result.success && result.data.scope).toBe("BOTH");
    expect(result.success && result.data.allowedAbstractFinalTypes).toEqual([]);
  });

  it("accepts an explicit REGISTRATION/ABSTRACT scope", () => {
    for (const scope of ["REGISTRATION", "ABSTRACT", "BOTH"]) {
      const result = CreateCertificateTemplateSchema.safeParse({
        name: "Cert",
        scope,
      });
      expect(result.success).toBe(true);
      expect(result.success && result.data.scope).toBe(scope);
    }
  });

  it("rejects a scope value outside the enum", () => {
    const result = CreateCertificateTemplateSchema.safeParse({
      name: "Cert",
      scope: "EVERYONE",
    });
    expect(result.success).toBe(false);
  });

  it("accepts allowedAbstractFinalTypes members and rejects unknown values", () => {
    const ok = CreateCertificateTemplateSchema.safeParse({
      name: "Cert",
      allowedAbstractFinalTypes: ["ORAL_COMMUNICATION", "POSTER"],
    });
    expect(ok.success).toBe(true);

    const bad = CreateCertificateTemplateSchema.safeParse({
      name: "Cert",
      allowedAbstractFinalTypes: ["KEYNOTE"],
    });
    expect(bad.success).toBe(false);
  });
});

describe("UpdateCertificateTemplateSchema — scope + allowedAbstractFinalTypes (H2)", () => {
  it("leaves scope/allowedAbstractFinalTypes undefined when omitted (sparse patch)", () => {
    const result = UpdateCertificateTemplateSchema.safeParse({ name: "Renamed" });
    expect(result.success).toBe(true);
    expect(result.success && result.data.scope).toBeUndefined();
    expect(result.success && result.data.allowedAbstractFinalTypes).toBeUndefined();
  });

  it("accepts an explicit scope + allowedAbstractFinalTypes patch", () => {
    const result = UpdateCertificateTemplateSchema.safeParse({
      scope: "ABSTRACT",
      allowedAbstractFinalTypes: ["CONFERENCE"],
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.scope).toBe("ABSTRACT");
  });

  it("rejects an invalid scope on update", () => {
    const result = UpdateCertificateTemplateSchema.safeParse({ scope: "NONE" });
    expect(result.success).toBe(false);
  });
});
