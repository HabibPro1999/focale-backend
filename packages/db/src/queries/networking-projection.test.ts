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
