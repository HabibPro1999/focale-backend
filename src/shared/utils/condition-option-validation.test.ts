import { describe, expect, it } from "vitest";
import {
  buildFieldOptionIndex,
  findInvalidOptionConditions,
} from "./condition-option-validation.js";

const sampleSchema = {
  steps: [
    {
      id: "step-1",
      title: "Registrant Info",
      fields: [
        {
          id: "country_x",
          type: "country",
          label: "Country",
          options: [
            { id: "TN", label: "Tunisie" },
            { id: "FR", label: "France" },
            { id: "DZ", label: "Algérie" },
            { id: "DE", label: "Allemagne" },
          ],
        },
        {
          id: "first_name",
          type: "text",
          label: "First Name",
        },
        {
          id: "no_label_dropdown",
          type: "dropdown",
          options: [{ id: "opt-a" }, { id: "opt-b" }],
        },
        {
          id: "empty_options_field",
          type: "dropdown",
          label: "Empty Options",
          options: [],
        },
      ],
    },
  ],
};

describe("buildFieldOptionIndex", () => {
  it("indexes a field with a non-empty options array", () => {
    const index = buildFieldOptionIndex(sampleSchema);
    const info = index.get("country_x");

    expect(info).toBeDefined();
    expect(info?.fieldLabel).toBe("Country");
    expect([...(info?.optionIds ?? [])].sort()).toEqual([
      "DE",
      "DZ",
      "FR",
      "TN",
    ]);
  });

  it("excludes fields without an options array", () => {
    const index = buildFieldOptionIndex(sampleSchema);
    expect(index.has("first_name")).toBe(false);
  });

  it("excludes fields with an empty options array", () => {
    const index = buildFieldOptionIndex(sampleSchema);
    expect(index.has("empty_options_field")).toBe(false);
  });

  it("falls back to the field id when label is missing", () => {
    const index = buildFieldOptionIndex(sampleSchema);
    expect(index.get("no_label_dropdown")?.fieldLabel).toBe(
      "no_label_dropdown",
    );
  });

  it("caps example option ids at 3, preserving declaration order", () => {
    const index = buildFieldOptionIndex(sampleSchema);
    expect(index.get("country_x")?.exampleOptionIds).toEqual([
      "TN",
      "FR",
      "DZ",
    ]);
  });

  it("returns an empty map for a malformed or missing schema", () => {
    expect(buildFieldOptionIndex(null).size).toBe(0);
    expect(buildFieldOptionIndex(undefined).size).toBe(0);
    expect(buildFieldOptionIndex("not an object").size).toBe(0);
    expect(buildFieldOptionIndex({}).size).toBe(0);
    expect(buildFieldOptionIndex({ steps: "not an array" }).size).toBe(0);
    expect(buildFieldOptionIndex({ steps: [{ fields: "nope" }] }).size).toBe(
      0,
    );
  });
});

describe("findInvalidOptionConditions", () => {
  const index = buildFieldOptionIndex(sampleSchema);

  it("accepts equals with a real option id", () => {
    const result = findInvalidOptionConditions(
      [{ fieldId: "country_x", operator: "equals", value: "TN" }],
      index,
    );
    expect(result).toEqual([]);
  });

  it("flags equals with an option label instead of an id", () => {
    const result = findInvalidOptionConditions(
      [{ fieldId: "country_x", operator: "equals", value: "Tunisie" }],
      index,
    );
    expect(result).toEqual([
      {
        fieldId: "country_x",
        fieldLabel: "Country",
        operator: "equals",
        value: "Tunisie",
        exampleOptionIds: ["TN", "FR", "DZ"],
      },
    ]);
  });

  it("flags not_equals with an option label instead of an id", () => {
    const result = findInvalidOptionConditions(
      [{ fieldId: "country_x", operator: "not_equals", value: "Tunisie" }],
      index,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      fieldId: "country_x",
      fieldLabel: "Country",
      operator: "not_equals",
      value: "Tunisie",
    });
  });

  it("flags an `in` condition when one element is not a real option id", () => {
    const result = findInvalidOptionConditions(
      [{ fieldId: "country_x", operator: "in", value: ["TN", "Tunisie"] }],
      index,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      fieldId: "country_x",
      operator: "in",
      value: "Tunisie",
    });
  });

  it("accepts an `in` condition when every element is a real option id", () => {
    const result = findInvalidOptionConditions(
      [{ fieldId: "country_x", operator: "in", value: ["TN", "FR"] }],
      index,
    );
    expect(result).toEqual([]);
  });

  it("skips a condition on an unknown fieldId", () => {
    const result = findInvalidOptionConditions(
      [{ fieldId: "does_not_exist", operator: "equals", value: "Tunisie" }],
      index,
    );
    expect(result).toEqual([]);
  });

  it("skips a condition on a field with no options", () => {
    const result = findInvalidOptionConditions(
      [{ fieldId: "first_name", operator: "equals", value: "anything" }],
      index,
    );
    expect(result).toEqual([]);
  });

  it("skips non-string values (number, boolean, null)", () => {
    const result = findInvalidOptionConditions(
      [
        { fieldId: "country_x", operator: "equals", value: 42 },
        { fieldId: "country_x", operator: "equals", value: true },
        { fieldId: "country_x", operator: "equals", value: null },
      ],
      index,
    );
    expect(result).toEqual([]);
  });

  it("skips an empty string value", () => {
    const result = findInvalidOptionConditions(
      [{ fieldId: "country_x", operator: "equals", value: "" }],
      index,
    );
    expect(result).toEqual([]);
  });

  it("skips valueless operators (is_empty / is_not_empty)", () => {
    const result = findInvalidOptionConditions(
      [
        { fieldId: "country_x", operator: "is_empty" },
        { fieldId: "country_x", operator: "is_not_empty" },
      ],
      index,
    );
    expect(result).toEqual([]);
  });

  it("skips operators with no notion of an option id", () => {
    const result = findInvalidOptionConditions(
      [
        { fieldId: "country_x", operator: "contains", value: "Tun" },
        { fieldId: "country_x", operator: "not_contains", value: "Tun" },
        { fieldId: "country_x", operator: "greater_than", value: 5 },
        { fieldId: "country_x", operator: "less_than", value: 5 },
      ],
      index,
    );
    expect(result).toEqual([]);
  });

  it("returns an empty array for a malformed conditions input", () => {
    expect(
      findInvalidOptionConditions(
        null as unknown as [],
        index,
      ),
    ).toEqual([]);
  });
});
