import { describe, expect, it } from "vitest";
import { z } from "zod";
import { StoredCertificateZonesSchema } from "./certificates";
import { StoredEmailContextSnapshotSchema } from "./email";
import { StoredFormSchemaJsonSchema } from "./forms";
import { StoredPricingRulesSchema } from "./pricing";
import { checkStoredJson, formatStoredJsonPath } from "./stored-json";

const rule = {
  id: "8c0f5d8e-4b8a-4e0b-9a55-2f1f6c1e7a10",
  name: "Members",
  description: null,
  priority: 0,
  conditions: [{ fieldId: "membership", operator: "equals", value: "member" }],
  conditionLogic: "AND",
  price: 150,
  active: true,
};

const zone = {
  id: "z1",
  x: 10,
  y: 20,
  width: 50,
  height: 10,
  variable: "fullName",
  fontSize: null,
  fontWeight: "bold",
  color: "#000000",
  textAlign: "center",
};

const registrationSchema = {
  steps: [
    {
      id: "s1",
      title: "Profile",
      fields: [{ id: "email", type: "email", label: "Email", required: true }],
    },
  ],
  settings: { isFree: true, screens: { intro: "hello" } },
  legacyTopLevelKey: { kept: true },
};

const sponsorSchema = {
  formType: "SPONSOR",
  sponsorSteps: [
    { id: "s1", title: "Lab", fields: [{ id: "labName", type: "text", label: "Lab" }] },
  ],
  beneficiaryTemplate: {
    fields: [{ id: "name", type: "text", label: "Name" }],
    minCount: 1,
    maxCount: 100,
  },
  sponsorshipSettings: { sponsorshipMode: "CODE" },
};

describe("formatStoredJsonPath", () => {
  it("joins keys with dots and indices with brackets", () => {
    expect(formatStoredJsonPath([])).toBe("(root)");
    expect(formatStoredJsonPath([0, "conditions", 1, "operator"])).toBe("[0].conditions[1].operator");
    expect(formatStoredJsonPath(["steps", 0, "fields"])).toBe("steps[0].fields");
  });
});

describe("checkStoredJson", () => {
  it("accepts documents exactly as the write paths store them", () => {
    expect(checkStoredJson(StoredPricingRulesSchema, [rule])).toEqual([]);
    expect(checkStoredJson(StoredPricingRulesSchema, [])).toEqual([]);
    expect(checkStoredJson(StoredCertificateZonesSchema, [zone])).toEqual([]);
    expect(checkStoredJson(StoredFormSchemaJsonSchema, registrationSchema)).toEqual([]);
    expect(checkStoredJson(StoredFormSchemaJsonSchema, sponsorSchema)).toEqual([]);
    expect(checkStoredJson(StoredEmailContextSnapshotSchema, null)).toEqual([]);
    expect(
      checkStoredJson(StoredEmailContextSnapshotSchema, {
        firstName: "Ada",
        amount: 120,
        _certificateTemplateIds: ["t1"],
      }),
    ).toEqual([]);
  });

  it("ignores key order (JSONB does not keep it)", () => {
    const reordered = Object.fromEntries(Object.entries(rule).reverse());
    expect(checkStoredJson(StoredPricingRulesSchema, [reordered])).toEqual([]);
  });

  it("reports schema violations by path and code", () => {
    expect(
      checkStoredJson(StoredPricingRulesSchema, [
        rule,
        { ...rule, price: "150", conditions: [{ fieldId: "x", operator: "like" }] },
      ]),
    ).toEqual([
      { path: "[1].conditions[0].operator", code: "invalid_value" },
      { path: "[1].price", code: "invalid_type" },
    ]);
  });

  it("names each unknown key of a closed object (key names, not values)", () => {
    expect(
      checkStoredJson(StoredCertificateZonesSchema, [{ ...zone, legacyFont: "Arial", note: "x" }]),
    ).toEqual([
      { path: "[0].legacyFont", code: "unrecognized_keys" },
      { path: "[0].note", code: "unrecognized_keys" },
    ]);
  });

  it("reports a missing key the schema would default: the stored value is not the parsed output", () => {
    const { fontWeight: _fontWeight, ...withoutWeight } = zone;
    const { priority: _priority, ...withoutPriority } = rule;
    expect(checkStoredJson(StoredCertificateZonesSchema, [withoutWeight])).toEqual([
      { path: "[0].fontWeight", code: "missing_default" },
    ]);
    expect(checkStoredJson(StoredPricingRulesSchema, [withoutPriority])).toEqual([
      { path: "[0].priority", code: "missing_default" },
    ]);
  });

  it("reports keys parsing would strip and values it would rewrite", () => {
    const stripping = z.array(z.object({ a: z.string() }));
    expect(checkStoredJson(stripping, [{ a: "x", extra: 1 }])).toEqual([
      { path: "[0].extra", code: "stripped_key" },
    ]);
    const trimming = z.object({ name: z.string().trim() });
    expect(checkStoredJson(trimming, { name: " Ada " })).toEqual([
      { path: "name", code: "changed_value" },
    ]);
  });

  it("reports form-schema problems inside the branch the document meant", () => {
    const badRegistration = {
      ...registrationSchema,
      steps: [{ ...registrationSchema.steps[0], fields: [{ id: "email", type: "mail" }] }],
    };
    expect(checkStoredJson(StoredFormSchemaJsonSchema, badRegistration)).toEqual([
      { path: "steps[0].fields[0].type", code: "invalid_value" },
    ]);

    const { minCount: _minCount, ...template } = sponsorSchema.beneficiaryTemplate;
    expect(
      checkStoredJson(StoredFormSchemaJsonSchema, { ...sponsorSchema, beneficiaryTemplate: template }),
    ).toEqual([{ path: "beneficiaryTemplate.minCount", code: "missing_default" }]);

    const badSponsor = {
      ...sponsorSchema,
      sponsorSteps: [{ id: "s1", fields: [] }],
    };
    expect(checkStoredJson(StoredFormSchemaJsonSchema, badSponsor)).toEqual([
      { path: "sponsorSteps[0].title", code: "invalid_type" },
    ]);
  });

  it("rejects the wrong kind of value at the root", () => {
    expect(checkStoredJson(StoredPricingRulesSchema, { rules: [] })).toEqual([
      { path: "(root)", code: "invalid_type" },
    ]);
    expect(checkStoredJson(StoredEmailContextSnapshotSchema, ["a"])).toEqual([
      { path: "(root)", code: "invalid_type" },
    ]);
    expect(
      checkStoredJson(StoredEmailContextSnapshotSchema, { _certificateTemplateIds: [1] }),
    ).toEqual([{ path: "_certificateTemplateIds[0]", code: "invalid_type" }]);
  });

  it("never carries the offending values", () => {
    const secret = "registrant-secret-value";
    const issues = checkStoredJson(StoredPricingRulesSchema, [
      { ...rule, name: 42, legacyKey: secret, conditions: [{ fieldId: secret, operator: secret }] },
    ]);
    expect(issues).toEqual([
      { path: "[0].name", code: "invalid_type" },
      { path: "[0].conditions[0].operator", code: "invalid_value" },
      { path: "[0].legacyKey", code: "unrecognized_keys" },
    ]);
    expect(JSON.stringify(issues)).not.toContain(secret);
  });
});
