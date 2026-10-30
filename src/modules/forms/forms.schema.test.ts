import { describe, expect, it } from "vitest";
import {
  CreateFormSchema,
  FormSchemaJsonSchema,
  SponsorFormSchemaJsonSchema,
  UpdateFormSchema,
} from "./forms.schema.js";

const trilingualSchema = {
  settings: {
    languages: ["fr", "en", "ar"],
  },
  steps: [
    {
      id: "step-1",
      title: "Informations personnelles",
      description: "Tous les champs marqués * sont obligatoires",
      translations: {
        en: { title: "Personal information", description: "All fields" },
        ar: { title: "معلومات شخصية" },
      },
      fields: [
        {
          id: "field-1",
          type: "text" as const,
          label: "Nom complet",
          placeholder: "Votre nom",
          helpText: "Comme sur votre pièce d'identité",
          validation: {
            required: true,
            errorMessages: { required: "Ce champ est obligatoire" },
          },
          translations: {
            en: {
              label: "Full name",
              placeholder: "Your name",
              helpText: "As on your ID",
              errorMessages: { required: "This field is required" },
            },
            ar: {
              label: "الاسم الكامل",
              errorMessages: { required: "هذا الحقل مطلوب" },
            },
          },
        },
        {
          id: "field-2",
          type: "radio" as const,
          label: "Formule",
          options: [
            {
              id: "opt-1",
              label: "Standard",
              description: "Accès aux sessions",
              translations: {
                en: { label: "Standard", description: "Session access" },
                ar: { label: "قياسي" },
              },
            },
          ],
        },
        {
          id: "field-3",
          type: "paragraph" as const,
          content: "Merci de vérifier vos informations.",
          translations: {
            en: { content: "Please check your information." },
          },
        },
      ],
    },
  ],
};

describe("FormSchemaJsonSchema translations", () => {
  it("round-trips a fully translated schema verbatim", () => {
    const result = FormSchemaJsonSchema.safeParse(trilingualSchema);

    expect(result.success).toBe(true);
    expect(result.data).toEqual(trilingualSchema);
  });

  it("accepts a schema with no translations at all", () => {
    const result = FormSchemaJsonSchema.safeParse({
      steps: [
        {
          id: "step-1",
          title: "Info",
          fields: [{ id: "field-1", type: "text" as const, label: "Nom" }],
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("rejects an unknown language code on a field", () => {
    const result = FormSchemaJsonSchema.safeParse({
      steps: [
        {
          id: "step-1",
          title: "Info",
          fields: [
            {
              id: "field-1",
              type: "text" as const,
              label: "Nom",
              translations: { de: { label: "Name" } },
            },
          ],
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects an unknown language code on an option", () => {
    const result = FormSchemaJsonSchema.safeParse({
      steps: [
        {
          id: "step-1",
          title: "Info",
          fields: [
            {
              id: "field-1",
              type: "radio" as const,
              label: "Formule",
              options: [
                {
                  id: "opt-1",
                  label: "Standard",
                  translations: { de: { label: "Standard" } },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects an unknown language code on a step", () => {
    const result = FormSchemaJsonSchema.safeParse({
      steps: [
        {
          id: "step-1",
          title: "Info",
          translations: { de: { title: "Info" } },
          fields: [],
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects junk keys inside a field translation entry", () => {
    const result = FormSchemaJsonSchema.safeParse({
      steps: [
        {
          id: "step-1",
          title: "Info",
          fields: [
            {
              id: "field-1",
              type: "text" as const,
              label: "Nom",
              translations: { en: { label: "Name", title: "Nope" } },
            },
          ],
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects junk keys inside a field translation errorMessages entry", () => {
    const result = FormSchemaJsonSchema.safeParse({
      steps: [
        {
          id: "step-1",
          title: "Info",
          fields: [
            {
              id: "field-1",
              type: "text" as const,
              label: "Nom",
              translations: {
                en: { errorMessages: { notARule: "Nope" } },
              },
            },
          ],
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects junk keys inside an option translation entry", () => {
    const result = FormSchemaJsonSchema.safeParse({
      steps: [
        {
          id: "step-1",
          title: "Info",
          fields: [
            {
              id: "field-1",
              type: "radio" as const,
              options: [
                {
                  id: "opt-1",
                  label: "Standard",
                  translations: { en: { label: "Standard", helpText: "Nope" } },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects junk keys inside a step translation entry", () => {
    const result = FormSchemaJsonSchema.safeParse({
      steps: [
        {
          id: "step-1",
          title: "Info",
          translations: { en: { title: "Info", label: "Nope" } },
          fields: [],
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});

describe("FormSettingsSchema", () => {
  const withSettings = (settings: unknown) => ({
    settings,
    steps: [{ id: "step-1", title: "Info", fields: [] }],
  });

  it("accepts a single-language list", () => {
    const result = FormSchemaJsonSchema.safeParse(
      withSettings({ languages: ["fr"] }),
    );

    expect(result.success).toBe(true);
  });

  it("rejects an empty languages list", () => {
    const result = FormSchemaJsonSchema.safeParse(
      withSettings({ languages: [] }),
    );

    expect(result.success).toBe(false);
  });

  it("rejects duplicate languages", () => {
    const result = FormSchemaJsonSchema.safeParse(
      withSettings({ languages: ["fr", "fr"] }),
    );

    expect(result.success).toBe(false);
  });

  it("rejects more than three languages", () => {
    const result = FormSchemaJsonSchema.safeParse(
      withSettings({ languages: ["fr", "en", "ar", "es"] }),
    );

    expect(result.success).toBe(false);
  });

  it("rejects an unknown language code", () => {
    const result = FormSchemaJsonSchema.safeParse(
      withSettings({ languages: ["fr", "de"] }),
    );

    expect(result.success).toBe(false);
  });

  it("passes admin-authored settings keys through untouched", () => {
    const settings = {
      languages: ["fr", "en"],
      isFree: true,
      screens: { success: { title: "Merci" } },
      accessSectionTitle: "Vos accès",
    };

    const result = FormSchemaJsonSchema.safeParse(withSettings(settings));

    expect(result.success).toBe(true);
    expect(result.data?.settings).toEqual(settings);
  });

  it("keeps settings optional", () => {
    const result = FormSchemaJsonSchema.safeParse({
      steps: [{ id: "step-1", title: "Info", fields: [] }],
    });

    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty("settings");
  });

  it("round-trips a registration fee label and its sidecar verbatim", () => {
    const settings = {
      languages: ["fr", "en", "ar"],
      registrationFeeLabel: "Droits d'inscription 2026",
      translations: {
        en: { registrationFeeLabel: "Registration fees 2026" },
        ar: { registrationFeeLabel: "رسوم التسجيل 2026" },
      },
    };

    const result = FormSchemaJsonSchema.safeParse(withSettings(settings));

    expect(result.success).toBe(true);
    expect(result.data?.settings).toEqual(settings);
  });

  it("rejects an unknown language code on the settings sidecar", () => {
    const result = FormSchemaJsonSchema.safeParse(
      withSettings({
        translations: { de: { registrationFeeLabel: "Anmeldegebühr" } },
      }),
    );

    expect(result.success).toBe(false);
  });

  it("rejects junk keys inside a settings translation entry", () => {
    const result = FormSchemaJsonSchema.safeParse(
      withSettings({
        translations: {
          en: {
            registrationFeeLabel: "Registration fee",
            accessSectionTitle: "Nope",
          },
        },
      }),
    );

    expect(result.success).toBe(false);
  });

  it("rejects a non-string registration fee label", () => {
    const result = FormSchemaJsonSchema.safeParse(
      withSettings({ registrationFeeLabel: { fr: "Frais" } }),
    );

    expect(result.success).toBe(false);
  });

  it("rejects a registration fee label longer than 120 characters", () => {
    const result = FormSchemaJsonSchema.safeParse(
      withSettings({ registrationFeeLabel: "a".repeat(121) }),
    );

    expect(result.success).toBe(false);
  });
});

describe("SponsorFormSchemaJsonSchema translations", () => {
  const sponsorSchema = {
    formType: "SPONSOR" as const,
    settings: { languages: ["fr", "en"] },
    sponsorSteps: [
      {
        id: "step-1",
        title: "Informations du laboratoire",
        translations: { en: { title: "Lab information" } },
        fields: [
          {
            id: "labName",
            type: "text" as const,
            label: "Nom du laboratoire",
            translations: { en: { label: "Lab name" } },
          },
        ],
      },
    ],
    beneficiaryTemplate: {
      fields: [
        {
          id: "name",
          type: "text" as const,
          label: "Nom complet",
          translations: { en: { label: "Full name" } },
        },
      ],
      minCount: 1,
      maxCount: 100,
    },
    summarySettings: {
      title: "Récapitulatif",
      showPriceBreakdown: true,
      termsText: "J'accepte les conditions",
      translations: {
        en: { title: "Summary", termsText: "I accept the terms" },
      },
    },
  };

  it("round-trips sponsor translations verbatim", () => {
    const result = SponsorFormSchemaJsonSchema.safeParse(sponsorSchema);

    expect(result.success).toBe(true);
    expect(result.data).toEqual(sponsorSchema);
  });

  it("rejects an unknown language code on summary settings", () => {
    const result = SponsorFormSchemaJsonSchema.safeParse({
      ...sponsorSchema,
      summarySettings: {
        ...sponsorSchema.summarySettings,
        translations: { de: { title: "Zusammenfassung" } },
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts a registration fee label and its sidecar on sponsor settings", () => {
    const settings = {
      languages: ["fr", "en"],
      registrationFeeLabel: "Droits d'inscription 2026",
      translations: {
        en: { registrationFeeLabel: "Registration fees 2026" },
      },
    };

    const result = SponsorFormSchemaJsonSchema.safeParse({
      ...sponsorSchema,
      settings,
    });

    expect(result.success).toBe(true);
    expect(result.data?.settings).toEqual(settings);
  });

  it("rejects junk keys inside a summary translation entry", () => {
    const result = SponsorFormSchemaJsonSchema.safeParse({
      ...sponsorSchema,
      summarySettings: {
        ...sponsorSchema.summarySettings,
        translations: { en: { title: "Summary", label: "Nope" } },
      },
    });

    expect(result.success).toBe(false);
  });
});

describe("successTranslations", () => {
  const eventId = "0f9d5e5c-4d9b-4a49-9f19-1a6b6a5b5f11";

  it("accepts a success translations map on create", () => {
    const result = CreateFormSchema.safeParse({
      eventId,
      name: "Inscription",
      successTranslations: {
        en: { successTitle: "Thank you!", successMessage: "See you soon." },
        ar: { successTitle: "شكرا" },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts null to clear success translations on update", () => {
    const result = UpdateFormSchema.safeParse({ successTranslations: null });

    expect(result.success).toBe(true);
  });

  it("rejects an unknown language code", () => {
    const result = UpdateFormSchema.safeParse({
      successTranslations: { de: { successTitle: "Danke" } },
    });

    expect(result.success).toBe(false);
  });

  it("rejects junk keys inside a success translation entry", () => {
    const result = UpdateFormSchema.safeParse({
      successTranslations: { en: { successTitle: "Thanks", title: "Nope" } },
    });

    expect(result.success).toBe(false);
  });
});
