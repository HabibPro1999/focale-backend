import { describe, expect, it } from "vitest";
import {
  formatFormData,
  formatFormValue,
  indexFormFields,
  sampleFormValue,
  type FormFieldInfo,
} from "./form-values";

// The shapes stored in the dev database (form schema + form_data).
const schema = {
  steps: [
    {
      id: "s1",
      title: "Step",
      fields: [
        {
          id: "dropdown_1",
          type: "dropdown",
          options: [
            {
              id: "opt_1789425127764_74uxkdxc9",
              label: "Ingénieur ",
              translations: { en: { label: "Engineer" }, ar: { label: "مهندس" } },
            },
            { id: "opt_b", label: "Médecin" },
          ],
        },
        {
          id: "radio_1",
          type: "radio",
          options: [{ id: "r1", label: " Présentiel" }],
        },
        {
          id: "checkbox_1",
          type: "checkbox",
          options: [
            {
              id: "opt_s",
              label: "Des fournisseurs",
              translations: { en: { label: "Suppliers" }, ar: { label: "الموردون" } },
            },
            { id: "opt_x", label: "Autre" },
            {
              id: "opt_d",
              label: "Des distributeurs",
              translations: { en: { label: "Distributors" }, ar: { label: "الموزعون" } },
            },
          ],
        },
        {
          id: "consent_1",
          type: "checkbox",
          options: [{ id: "opt_c", label: "J'accepte les conditions générales" }],
        },
        { id: "country_1", type: "country" },
        {
          id: "governorate_1",
          type: "governorate",
          options: [
            { id: "ben-arous", label: "Ben Arous", translations: { ar: { label: "بن عروس" } } },
          ],
        },
        { id: "governorate_2", type: "governorate" },
        { id: "date_1", type: "date" },
        { id: "file_1", type: "file" },
        { id: "textarea_1", type: "textarea" },
        { id: "number_1", type: "number" },
        { id: "firstName_abc", type: "firstName" },
        { id: "heading_1", type: "heading" },
      ],
    },
  ],
};

const fields = indexFormFields(schema);
const field = (id: string) => fields.get(id) as FormFieldInfo;

describe("indexFormFields", () => {
  it("indexes every field of every step by id", () => {
    expect(fields.get("dropdown_1")?.type).toBe("dropdown");
    expect(fields.get("date_1")?.type).toBe("date");
    expect(fields.size).toBe(13);
  });

  it("gives an empty index for no schema or a malformed one", () => {
    expect(indexFormFields(null).size).toBe(0);
    expect(indexFormFields({ steps: "x" }).size).toBe(0);
    expect(indexFormFields({ steps: [{ fields: [null, { type: "text" }] }] }).size).toBe(0);
  });
});

describe("formatFormValue — by field type", () => {
  it.each([
    ["fr", "Ingénieur"],
    ["en", "Engineer"],
    ["ar", "مهندس"],
  ] as const)("dropdown → the option's label, translated and trimmed (%s)", (language, label) => {
    expect(formatFormValue("opt_1789425127764_74uxkdxc9", field("dropdown_1"), language)).toBe(label);
  });

  it("dropdown/radio without a translation → the label as typed, trimmed", () => {
    expect(formatFormValue("opt_b", field("dropdown_1"), "en")).toBe("Médecin");
    expect(formatFormValue("r1", field("radio_1"), "ar")).toBe("Présentiel");
  });

  it("never prints an unknown option id", () => {
    expect(formatFormValue("opt_gone", field("dropdown_1"), "fr")).toBe("");
    expect(formatFormValue("opt_gone", field("radio_1"), "fr")).toBe("");
    expect(formatFormValue(["opt_gone"], field("checkbox_1"), "fr")).toBe("");
  });

  it.each([
    ["fr", "Des fournisseurs, Des distributeurs"],
    ["en", "Suppliers, Distributors"],
    ["ar", "الموردون، الموزعون"],
  ] as const)("checkbox with several options → selected labels in option order (%s)", (language, out) => {
    expect(formatFormValue(["opt_d", "opt_s"], field("checkbox_1"), language)).toBe(out);
  });

  it.each([
    ["fr", "Oui"],
    ["en", "Yes"],
    ["ar", "نعم"],
  ] as const)("a single-option checkbox, ticked → yes (%s)", (language, yes) => {
    expect(formatFormValue(["opt_c"], field("consent_1"), language)).toBe(yes);
  });

  it("a single-option checkbox, unticked or empty → blank", () => {
    expect(formatFormValue([], field("consent_1"), "fr")).toBe("");
    expect(formatFormValue("", field("consent_1"), "fr")).toBe("");
    expect(formatFormValue(null, field("consent_1"), "fr")).toBe("");
  });

  it("a checkbox stored as a boolean keeps Oui/Non", () => {
    expect(formatFormValue(true, field("consent_1"), "fr")).toBe("Oui");
    expect(formatFormValue(false, field("checkbox_1"), "ar")).toBe("لا");
  });

  it.each([
    ["fr", "Tunisie"],
    ["en", "Tunisia"],
    ["ar", "تونس"],
  ] as const)("country → the region name (%s)", (language, name) => {
    expect(formatFormValue("TN", field("country_1"), language)).toBe(name);
  });

  it("country → the code when it names no region", () => {
    expect(formatFormValue("ZZZ", field("country_1"), "fr")).toBe("ZZZ");
  });

  it("governorate → the option label, translated when set, else the built-in list", () => {
    expect(formatFormValue("ben-arous", field("governorate_1"), "fr")).toBe("Ben Arous");
    expect(formatFormValue("ben-arous", field("governorate_1"), "en")).toBe("Ben Arous");
    expect(formatFormValue("ben-arous", field("governorate_1"), "ar")).toBe("بن عروس");
    expect(formatFormValue("medenine", field("governorate_2"), "fr")).toBe("Médenine");
    expect(formatFormValue("atlantis", field("governorate_2"), "fr")).toBe("");
  });

  it.each([
    ["fr", "19 novembre 2026"],
    ["en", "November 19, 2026"],
    ["ar", "19 نوفمبر 2026"],
  ] as const)("date → the long date, never shifted a day (%s)", (language, date) => {
    expect(formatFormValue("2026-11-19", field("date_1"), language)).toBe(date);
  });

  it("file → its name when the value carries one, else blank (never [object Object])", () => {
    expect(formatFormValue({}, field("file_1"), "fr")).toBe("");
    expect(formatFormValue({ name: "cv.pdf" }, field("file_1"), "fr")).toBe("cv.pdf");
    expect(formatFormValue({ fileName: "a.pdf" }, field("file_1"), "fr")).toBe("a.pdf");
    expect(formatFormValue({ originalName: "b.pdf" }, field("file_1"), "fr")).toBe("b.pdf");
  });

  it("textarea keeps its text and line breaks", () => {
    expect(formatFormValue("Ligne 1\nLigne 2", field("textarea_1"), "fr")).toBe("Ligne 1\nLigne 2");
  });

  it("number and text fields as stored", () => {
    expect(formatFormValue(42, field("number_1"), "fr")).toBe("42");
    expect(formatFormValue("Amira", field("firstName_abc"), "fr")).toBe("Amira");
  });
});

describe("formatFormValue — fields not in the schema", () => {
  it("keeps primitives, booleans in words, arrays joined", () => {
    expect(formatFormValue("cardio", undefined, "fr")).toBe("cardio");
    expect(formatFormValue(true, undefined, "fr")).toBe("Oui");
    expect(formatFormValue(["a", "b"], undefined, "en")).toBe("a, b");
    expect(formatFormValue(["a", "b"], undefined, "ar")).toBe("a، b");
  });

  it("never prints [object Object]", () => {
    expect(formatFormValue({}, undefined, "fr")).toBe("");
    expect(formatFormValue({ a: 1 }, undefined, "fr")).toBe("");
    expect(formatFormValue([{}, "x", { y: 1 }], undefined, "fr")).toBe("x");
    expect(formatFormValue({}, field("textarea_1"), "fr")).toBe("");
    expect(formatFormValue({ id: "opt_b" }, field("dropdown_1"), "fr")).toBe("");
  });
});

describe("formatFormData", () => {
  it("maps every answer to its form_<fieldId> variable", () => {
    expect(
      formatFormData(
        { dropdown_1: "opt_b", removed_1: { x: 1 }, country_1: "FR" },
        fields,
        "en",
      ),
    ).toEqual({
      form_dropdown_1: "Médecin",
      form_removed_1: "",
      form_country_1: "France",
    });
  });

  it("builds without a schema: primitives as stored, objects blank", () => {
    expect(formatFormData({ a: "opt_1", b: {} }, null, "fr")).toEqual({ form_a: "opt_1", form_b: "" });
  });
});

describe("sampleFormValue", () => {
  it("gives a real answer for the option, country and date fields", () => {
    expect(sampleFormValue(field("dropdown_1"), "en")).toBe("Engineer");
    expect(sampleFormValue(field("radio_1"), "fr")).toBe("Présentiel");
    expect(sampleFormValue(field("checkbox_1"), "ar")).toBe("الموردون");
    expect(sampleFormValue(field("consent_1"), "fr")).toBe("Oui");
    expect(sampleFormValue(field("country_1"), "fr")).toBe("Tunisie");
    expect(sampleFormValue(field("governorate_1"), "ar")).toBe("بن عروس");
    expect(sampleFormValue(field("date_1"), "fr")).toBe("15 mars 2025");
  });

  it("leaves the other types to the static examples", () => {
    expect(sampleFormValue(field("textarea_1"), "fr")).toBeUndefined();
    expect(sampleFormValue({ type: "dropdown" }, "fr")).toBeUndefined();
  });
});
