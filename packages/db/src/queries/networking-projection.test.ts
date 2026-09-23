import { describe, expect, it } from "vitest";
import { networkingConsentPending, networkingConsentText, projectNetworkingFields, resolveNetworkingConsent } from "./networking-projection";
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
      consent: "yes",
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
      consent: "unanswered",
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
    expect(projectNetworkingFields(schema, data, config).consent).toBe("unanswered");
    expect(JSON.stringify(data)).toBe(before);
  });
});

describe("networking consent matcher", () => {
  it.each([
    ["J’accepte de participer au networking", "yes"],
    ["J'accepte", "yes"],
    ["I agree to share my profile…", "yes"],
    ["Oui (non contractuel)", "yes"],
    ["Yes, please", "yes"],
    ["D’accord", "yes"],
    ["نعم، أوافق", "yes"],
    ["أُوافق على المشاركة", "yes"],
    ["ＹＥＳ", "yes"],
    ["Je ne souhaite pas participer", "no"],
    ["Je n’accepte pas", "no"],
    ["Non, merci", "no"],
    ["No, I don't agree", "no"],
    ["I don’t want to take part", "no"],
    ["I do not consent", "no"],
    ["Decline", "no"],
    ["لا أوافق", "no"],
    ["لَا", "no"],
    ["None of these", "unanswered"],
    ["Nonprofit organisation", "unanswered"],
    ["Notify me later", "unanswered"],
    ["Maybe", "unanswered"],
    ["", "unanswered"],
    ["true", "yes"],
    ["false", "no"],
  ] as const)("%s ⇒ %s", (label, verdict) => {
    expect(networkingConsentText(label)).toBe(verdict);
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
    ["radio", "J’accepte de participer au networking", "yes"],
    ["dropdown", "Oui (non contractuel)", "yes"],
    ["radio", "Je ne souhaite pas participer", "no"],
    ["checkbox", "None of these", "unanswered"],
    ["radio", "Non", "no"],
  ] as const)("reads the selected %s option label %s as %s", (type, label, verdict) => {
    expect(project(type, type === "checkbox" ? ["option"] : "option", [{ id: "option", label }, { id: "other", label: "Other" }])).toBe(verdict);
  });
  it("treats a ticked single-option checkbox as consent unless its label is negative", () => {
    expect(project("checkbox", ["opt"], [{ id: "opt", label: "Participer au networking B2B" }])).toBe("yes");
    expect(project("checkbox", ["opt"], [{ id: "opt", label: "Je ne souhaite pas être contacté" }])).toBe("no");
    expect(project("checkbox", [], [{ id: "opt", label: "Participer au networking B2B" }])).toBe("unanswered");
  });
  it("never reads consent from option IDs, only labels, values and translations", () => {
    expect(project("dropdown", "yes", [{ id: "yes", label: "Participate" }, { id: "no", label: "Skip" }])).toBe("unanswered");
    expect(project("dropdown", "no", [{ id: "no", label: "Oui" }, { id: "yes", label: "Non" }])).toBe("yes");
    expect(project("dropdown", "option", [{ id: "option", value: "yes", label: "Participate" }, { id: "b", label: "B" }])).toBe("yes");
    expect(project("radio", "option", [{ id: "option", label: "Participate", translations: { fr: { label: "Oui" } } }, { id: "b", label: "B" }])).toBe("yes");
  });
  it("lets any negative selected label or translation veto an affirmative one", () => {
    expect(project("checkbox", ["positive", "negative"], [{ id: "positive", label: "Yes" }, { id: "negative", label: "No" }])).toBe("no");
    expect(project("radio", "yes", [{ id: "yes", label: "Yes", translations: { fr: { label: "Non" } } }, { id: "b", label: "B" }])).toBe("no");
  });
  it.each([[true, "yes"], [false, "no"]] as const)("maps boolean %s to %s", (answer, verdict) => {
    expect(project("checkbox", answer)).toBe(verdict);
  });
  it("is unanswered for unknown options, missing answers, unmapped and deleted fields", () => {
    const options = [{ id: "positive", label: "Yes" }, { id: "neutral", label: "Maybe" }];
    for (const answer of ["deleted", "neutral", [], ["deleted"], undefined]) expect(project("checkbox", answer, options)).toBe("unanswered");
    expect(project("text", undefined)).toBe("unanswered");
    expect(projectNetworkingFields(schema, { consent: ["yes"] }, { fieldMapping: {}, defaultLanguage: "en" }).consent).toBe("unanswered");
    expect(projectNetworkingFields({}, { consent: true }, consentConfig).consent).toBe("unanswered");
  });
});

describe("K1 consent resolution", () => {
  it.each([
    [{ optIn: true, choice: undefined, mapped: "no" }, { consent: true, undecided: false }],
    [{ optIn: false, choice: true, mapped: "yes" }, { consent: false, undecided: false }],
    [{ optIn: null, choice: true, mapped: "no" }, { consent: true, undecided: false }],
    [{ optIn: null, choice: false, mapped: "yes" }, { consent: false, undecided: false }],
    [{ optIn: null, choice: undefined, mapped: "yes" }, { consent: true, undecided: false }],
    [{ optIn: null, choice: undefined, mapped: "no" }, { consent: false, undecided: false }],
    [{ optIn: null, choice: undefined, mapped: "unanswered" }, { consent: false, undecided: true }],
    [{ optIn: undefined, choice: undefined, mapped: "unanswered" }, { consent: false, undecided: true }],
  ] as const)("%j ⇒ %j", (input, expected) => {
    expect(resolveNetworkingConsent({ ...input, withdrawn: false })).toEqual(expected);
  });
  it("withdrawal always wins", () => {
    expect(resolveNetworkingConsent({ optIn: true, choice: true, mapped: "yes", withdrawn: true })).toEqual({ consent: false, undecided: false });
  });
  it("lets undecided registrants sign in to choose, never those who said no or withdrew", () => {
    const form = { fields: [{ id: "consent", type: "radio", options: [{ id: "a", label: "Oui" }, { id: "b", label: "Non" }] }] };
    const input = (overrides: object = {}) => ({
      profile: { consent: false, withdrawnAt: null, overrides: {} }, optIn: null, formSchema: form, formData: {},
      config: { fieldMapping: { consent: "consent" }, defaultLanguage: "fr" as const }, ...overrides,
    });
    expect(networkingConsentPending(input())).toBe(true);
    expect(networkingConsentPending(input({ formData: { consent: "b" } }))).toBe(false);
    expect(networkingConsentPending(input({ optIn: false }))).toBe(false);
    expect(networkingConsentPending(input({ profile: { consent: false, withdrawnAt: new Date(), overrides: {} } }))).toBe(false);
    expect(networkingConsentPending(input({ profile: { consent: false, withdrawnAt: null, overrides: { consent: false } } }))).toBe(false);
    expect(networkingConsentPending(input({ profile: { consent: true, withdrawnAt: null, overrides: {} } }))).toBe(false);
  });
});
