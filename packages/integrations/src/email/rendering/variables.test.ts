import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/db", () => ({
  getRegistrationFormSchema: vi.fn(),
}));

import { getRegistrationFormSchema } from "@app/db";
import {
  BASE_VARIABLES,
  getAvailableVariables,
  getSampleEmailContextForEvent,
} from "./variables";

describe("BASE_VARIABLES", () => {
  it("covers the core categories", () => {
    const categories = new Set(BASE_VARIABLES.map((v) => v.category));
    for (const c of [
      "registration",
      "event",
      "payment",
      "access",
      "links",
      "bank",
      "sponsorship",
      "certificate",
      "abstract",
    ]) {
      expect(categories.has(c as never)).toBe(true);
    }
  });

  it("every entry has a non-empty example", () => {
    for (const v of BASE_VARIABLES) {
      expect(v.example && v.example.length > 0).toBe(true);
    }
  });

  // M7 gap: the ABSTRACT_COMMITTEE_INVITE templated path (committee service)
  // substitutes exactly reviewerName/eventName/loginLink — eventName already
  // existed under "event"; reviewerName/loginLink must be picker-visible too.
  it("lists the ABSTRACT_COMMITTEE_INVITE variables under the abstract category", () => {
    const byId = new Map(BASE_VARIABLES.map((v) => [v.id, v]));
    expect(byId.get("reviewerName")).toMatchObject({ category: "abstract" });
    expect(byId.get("loginLink")).toMatchObject({ category: "abstract" });
  });

  it("lists eventDateRange under event, translated", async () => {
    vi.mocked(getRegistrationFormSchema).mockResolvedValue(null);
    expect(BASE_VARIABLES.find((v) => v.id === "eventDateRange")).toMatchObject({ category: "event" });
    const fr = await getAvailableVariables("evt-1", "fr");
    expect(fr.find((v) => v.id === "eventDateRange")?.label).toBe("Dates de l’événement");
  });
});

describe("form_* examples and the sample context", () => {
  const schema = {
    steps: [
      {
        fields: [
          {
            id: "job",
            type: "dropdown",
            label: "Profession",
            options: [
              { id: "opt_1", label: "Ingénieur ", translations: { en: { label: "Engineer" } } },
              { id: "opt_2", label: "Médecin" },
            ],
          },
          { id: "consent", type: "checkbox", options: [{ id: "c", label: "J'accepte" }] },
          { id: "tags", type: "checkbox", options: [{ id: "t1", label: "Fournisseurs" }, { id: "t2", label: "B" }] },
          { id: "country", type: "country" },
          { id: "gov", type: "governorate", options: [{ id: "ben-arous", label: "Ben Arous", translations: { ar: { label: "بن عروس" } } }] },
          { id: "arrival", type: "date" },
          { id: "cv", type: "file" },
        ],
      },
    ],
  };

  beforeEach(() => {
    vi.mocked(getRegistrationFormSchema).mockResolvedValue(schema as never);
  });

  it("gives each form variable a real example in the language", async () => {
    const example = async (language: "fr" | "en" | "ar") =>
      Object.fromEntries(
        (await getAvailableVariables("evt-1", language))
          .filter((v) => v.category === "form")
          .map((v) => [v.id, v.example]),
      );
    expect(await example("fr")).toEqual({
      form_job: "Ingénieur",
      form_consent: "Oui",
      form_tags: "Fournisseurs",
      form_country: "Tunisie",
      form_gov: "Ben Arous",
      form_arrival: "15 mars 2025",
      form_cv: "[Uploaded file]",
    });
    expect(await example("en")).toMatchObject({
      form_job: "Engineer",
      form_consent: "Yes",
      form_country: "Tunisia",
      form_arrival: "March 15, 2025",
    });
    expect(await example("ar")).toMatchObject({
      form_consent: "نعم",
      form_country: "تونس",
      form_gov: "بن عروس",
    });
  });

  it("fills the sample context's form_* keys from the examples", async () => {
    const ctx = await getSampleEmailContextForEvent("evt-1", "fr");
    expect(ctx).toMatchObject({
      firstName: "John",
      form_job: "Ingénieur",
      form_country: "Tunisie",
      eventDateRange: "20–22 avril 2025",
    });
  });

  it("is the plain sample context without an event", async () => {
    const ctx = await getSampleEmailContextForEvent(null, "fr");
    expect(Object.keys(ctx).some((k) => k.startsWith("form_"))).toBe(false);
    expect(getRegistrationFormSchema).not.toHaveBeenCalledWith(null);
  });
});

describe("getAvailableVariables", () => {
  beforeEach(() => {
    vi.mocked(getRegistrationFormSchema).mockResolvedValue(null);
  });

  it("returns base-only when no registration form exists", async () => {
    const vars = await getAvailableVariables("evt-1");
    expect(vars).toHaveLength(BASE_VARIABLES.length);
  });

  it("appends form_<id> entries and skips non-data field types", async () => {
    vi.mocked(getRegistrationFormSchema).mockResolvedValue({
      steps: [
        {
          fields: [
            { id: "specialty", label: "Specialty", type: "text" },
            { id: "sec", label: "Section", type: "heading" },
            { id: "note", type: "paragraph" },
          ],
        },
      ],
    } as never);
    const vars = await getAvailableVariables("evt-1");
    const formVars = vars.filter((v) => v.category === "form");
    expect(formVars).toHaveLength(1);
    expect(formVars[0].id).toBe("form_specialty");
    expect(formVars[0].label).toBe("Specialty");
    expect(formVars[0].example).toBe("Sample text");
  });

  it("uses the field id as the label when none is provided", async () => {
    vi.mocked(getRegistrationFormSchema).mockResolvedValue({
      steps: [{ fields: [{ id: "foo", type: "number" }] }],
    } as never);
    const vars = await getAvailableVariables("evt-1");
    const formVar = vars.find((v) => v.id === "form_foo");
    expect(formVar?.label).toBe("foo");
    expect(formVar?.example).toBe("42");
  });
});

it("localizes labels/descriptions and translated form labels without changing variable IDs", async () => {
  vi.mocked(getRegistrationFormSchema).mockResolvedValue({ steps: [{ fields: [{ id: "city", type: "text", label: "City", translations: { fr: { label: "Ville" }, ar: { label: "المدينة" } } }] }] } as never);
  const fr = await getAvailableVariables("event", "fr");
  const ar = await getAvailableVariables("event", "ar");
  expect(fr.find(v => v.id === "firstName")).toMatchObject({ label: "Prénom", description: "Prénom de la personne inscrite" });
  expect(ar.find(v => v.id === "firstName")?.label).toBe("الاسم الأول");
  expect(fr.find(v => v.id === "form_city")?.label).toBe("Ville");
  expect(ar.find(v => v.id === "form_city")?.label).toBe("المدينة");
  for (const list of [fr, ar]) expect(list.slice(0, BASE_VARIABLES.length).map(v => v.id)).toEqual(BASE_VARIABLES.map(v => v.id));
});
