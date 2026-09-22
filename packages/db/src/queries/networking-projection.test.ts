import { describe, expect, it } from "vitest";
import { projectNetworkingFields } from "./networking-projection";
const schema = {
  steps: [
    {
      fields: [
        {
          id: "sector",
          type: "dropdown",
          options: [
            {
              id: "uuid-finance",
              label: "Finance",
              translations: {
                ar: { label: "تمويل" },
                en: { label: "Financial services" },
              },
            },
          ],
        },
        {
          id: "interests",
          type: "checkbox",
          options: [
            {
              id: "uuid-health",
              label: "Santé",
              translations: { en: { label: "Healthcare" } },
            },
            {
              id: "uuid-investment",
              label: "Investissement",
              translations: { en: { label: "Investment" } },
            },
          ],
        },
        {
          id: "consent",
          type: "checkbox",
          options: [{ id: "yes", label: "J'accepte" }],
        },
        { id: "bio", type: "textarea" },
      ],
    },
  ],
};
const config = {
  fieldMapping: {
    sector: "sector",
    interests: "interests",
    consent: "consent",
    bio: "bio",
  },
  defaultLanguage: "en" as const,
};
describe("networking registration label projection", () => {
  it("resolves select and checkbox option IDs in the networking language", () => {
    expect(
      projectNetworkingFields(
        schema,
        {
          sector: "uuid-finance",
          interests: ["uuid-health", "uuid-investment"],
          consent: ["yes"],
          bio: "Offer",
        },
        config,
      ),
    ).toEqual({
      projection: {
        company: "", jobTitle: "", city: "", country: "", offers: "", seeks: "", website: null, photoUrl: null,
        sector: "Financial services",
        interests: ["Healthcare", "Investment"],
        bio: "Offer",
      },
      consent: true,
    });
  });
  it("drops deleted option IDs and clears missing mappings", () => {
    expect(
      projectNetworkingFields(
        schema,
        {
          sector: "deleted-uuid",
          interests: ["deleted-uuid", "uuid-health"],
          consent: [],
        },
        {
          ...config,
          fieldMapping: { ...config.fieldMapping, company: "deleted-field" },
        },
      ),
    ).toEqual({
      projection: {
        company: "", jobTitle: "", city: "", country: "", offers: "", seeks: "", website: null, photoUrl: null,
        sector: "",
        interests: ["Healthcare"],
        bio: "",
      },
      consent: false,
    });
  });
  it("falls back to the base label when the requested translation is absent", () => {
    expect(
      projectNetworkingFields(
        schema,
        { interests: ["uuid-health"] },
        { fieldMapping: { interests: "interests" }, defaultLanguage: "ar" },
      ).projection.interests,
    ).toEqual(["Santé"]);
  });
  it("keeps source answers unchanged and never infers consent from an unknown answer", () => {
    const data = { sector: "uuid-finance", consent: ["deleted-consent"] };
    const before = JSON.stringify(data);
    expect(projectNetworkingFields(schema, data, config).consent).toBe(false);
    expect(JSON.stringify(data)).toBe(before);
  });
});

describe("networking consent projection", () => {
  const consentConfig = { fieldMapping: { consent: "consent" }, defaultLanguage: "en" as const };
  function project(type: string, answer: unknown, options: unknown[] = []) {
    return projectNetworkingFields(
      { fields: [{ id: "consent", type, options }] },
      { consent: answer },
      consentConfig,
    ).consent;
  }

  it.each([
    ["radio", "No"],
    ["radio", "Non"],
    ["dropdown", "I do not consent"],
    ["checkbox", "no"],
    ["multi", "لا"],
  ])("rejects a negative %s option labelled %s", (type, label) => {
    expect(project(type, type === "checkbox" || type === "multi" ? ["option"] : "option", [
      { id: "option", label },
    ])).toBe(false);
  });

  it.each(["Yes", "Oui", "نعم", "J'accepte", "accept", "agree"])("accepts affirmative option %s", (label) => {
    expect(project("select", "option", [{ id: "option", label }])).toBe(true);
  });

  it.each([true, false])("preserves boolean %s", (answer) => {
    expect(project("checkbox", answer)).toBe(answer);
  });

  it.each(["true", "YES", "on", "1", "oui", "accept", "agree", "j'accepte", "نعم"])("accepts affirmative scalar %s", (answer) => {
    expect(project("text", answer)).toBe(true);
  });

  it.each([undefined, "", "unknown", "no", false])("rejects unmatched scalar %s", (answer) => {
    expect(project("text", answer)).toBe(false);
  });

  it("uses any configured translation, not only the default language", () => {
    expect(project("radio", "option", [{
      id: "option", label: "Participate", translations: { fr: { label: "Oui" } },
    }])).toBe(true);
  });

  it("recognizes selected option values and IDs", () => {
    expect(project("dropdown", "option", [{ id: "option", value: "yes", label: "Participate" }])).toBe(true);
    expect(project("checkbox", ["yes"], [{ id: "yes", label: "Participate" }])).toBe(true);
  });

  it.each(["false", "0", "off", "no", "non", "decline", "refuse", "I do not consent", "I don't consent", "لا"])("lets negative option %s veto an affirmative selection", (label) => {
    expect(project("checkbox", ["positive", "negative"], [
      { id: "positive", label: "Yes" }, { id: "negative", label },
    ])).toBe(false);
  });

  it("lets a negative translation veto an affirmative value", () => {
    expect(project("radio", "yes", [{
      id: "yes", label: "Yes", translations: { fr: { label: "Non" } },
    }])).toBe(false);
  });

  it("ignores unselected affirmative options and rejects unknown IDs, even affirmative-looking ones", () => {
    const options = [{ id: "positive", label: "Yes" }, { id: "neutral", label: "Maybe" }];
    for (const answer of ["deleted", "yes", "neutral", [], ["deleted"]]) {
      expect(project("checkbox", answer, options)).toBe(false);
    }
  });

  it("keeps unmapped consent enabled for compatibility", () => {
    expect(projectNetworkingFields(schema, { consent: false }, {
      fieldMapping: {}, defaultLanguage: "en",
    }).consent).toBe(true);
  });

  it("rejects a deleted consent field mapping", () => {
    expect(projectNetworkingFields({}, { consent: true }, consentConfig).consent).toBe(false);
  });
});
