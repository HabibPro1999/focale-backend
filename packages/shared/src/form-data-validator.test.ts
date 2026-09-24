import { describe, expect, it } from "vitest";
import { validateFormData, sanitizeFormData } from "./form-data-validator";

describe("validateFormData — field.required", () => {
  const schema = {
    steps: [
      {
        id: "step-1",
        title: "Step 1",
        fields: [
          {
            // required at top level (field.required), no validation object
            id: "firstName",
            type: "text" as const,
            label: "First Name",
            required: true,
          },
          {
            // required via nested validation.required
            id: "email",
            type: "email" as const,
            label: "Email",
            required: false,
            validation: { required: true },
          },
          {
            // not required either way
            id: "phone",
            type: "text" as const,
            label: "Phone",
            required: false,
          },
        ],
      },
    ],
  };

  it("should reject empty value for field with field.required = true", () => {
    const result = validateFormData(schema, {
      firstName: "",
      email: "a@b.com",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.fieldId === "firstName")).toBe(true);
  });

  it("should reject empty value for field with validation.required = true", () => {
    const result = validateFormData(schema, {
      firstName: "Alice",
      email: "",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.fieldId === "email")).toBe(true);
  });

  it("should accept empty value for optional field", () => {
    const result = validateFormData(schema, {
      firstName: "Alice",
      email: "a@b.com",
      phone: "",
    });
    expect(result.valid).toBe(true);
  });

  it("should treat field.required=true as required even when validation.required=false", () => {
    const conflictingSchema = {
      steps: [
        {
          id: "step-1",
          title: "Step 1",
          fields: [
            {
              id: "nickname",
              type: "text" as const,
              label: "Nickname",
              required: true,
              validation: { required: false },
            },
          ],
        },
      ],
    };

    const result = validateFormData(conflictingSchema, { nickname: "" });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.fieldId === "nickname")).toBe(true);
  });
});

describe("validateFormData and sanitizeFormData — hardened schemas", () => {
  it("should return structured validation errors and empty sanitization for malformed schemas", () => {
    const malformedSchema = {} as never;

    const result = validateFormData(malformedSchema, { name: "Alice" });

    expect(result).toMatchObject({
      valid: false,
      errors: [
        expect.objectContaining({
          fieldId: "schema",
          code: "invalid_schema",
        }),
      ],
    });
    expect(sanitizeFormData(malformedSchema, { name: "Alice" })).toEqual({});
  });

  it("should reject blank required numbers while accepting zero and optional blanks", () => {
    const numberSchema = {
      steps: [
        {
          id: "step-1",
          title: "Step 1",
          fields: [
            {
              id: "age",
              type: "number" as const,
              label: "Age",
              validation: { required: true, minValue: 0 },
            },
            {
              id: "score",
              type: "number" as const,
              label: "Score",
              validation: { minValue: 0, maxValue: 10 },
            },
          ],
        },
      ],
    };

    expect(validateFormData(numberSchema, { age: "", score: "" }).valid).toBe(
      false,
    );
    expect(validateFormData(numberSchema, { age: null }).valid).toBe(false);
    expect(validateFormData(numberSchema, { age: undefined }).valid).toBe(
      false,
    );
    expect(validateFormData(numberSchema, { age: 0, score: "" }).valid).toBe(
      true,
    );
    expect(validateFormData(numberSchema, { age: true }).valid).toBe(false);
    expect(validateFormData(numberSchema, { age: "   " }).valid).toBe(false);
    expect(validateFormData(numberSchema, { age: "0x10" }).valid).toBe(false);
    expect(validateFormData(numberSchema, { age: "25" }).data).toMatchObject({
      age: 25,
    });
  });

  it("should reject whitespace-only required text and invalid dates", () => {
    const schema = {
      steps: [
        {
          id: "step-1",
          title: "Step 1",
          fields: [
            {
              id: "name",
              type: "text" as const,
              label: "Name",
              required: true,
            },
            {
              id: "birthdate",
              type: "date" as const,
              label: "Birthdate",
              required: true,
              validation: { minDate: "2020-01-01" },
            },
          ],
        },
      ],
    };

    expect(
      validateFormData(schema, { name: "   ", birthdate: "2026-01-01" }).valid,
    ).toBe(false);
    expect(
      validateFormData(schema, { name: "Alice", birthdate: "not-a-date" })
        .valid,
    ).toBe(false);
  });

  it("should enforce supported validation key aliases", () => {
    const schema = {
      steps: [
        {
          id: "step-1",
          title: "Step 1",
          fields: [
            {
              id: "attachment",
              type: "file" as const,
              label: "Attachment",
              validation: { acceptedFileTypes: ["pdf"] },
            },
            {
              id: "choices",
              type: "checkbox" as const,
              label: "Choices",
              options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
                { id: "c", label: "C" },
              ],
              validation: { minSelections: 2, maxSelections: 2 },
            },
            {
              id: "count",
              type: "number" as const,
              label: "Count",
              validation: { minValue: 1, maxValue: 3 },
            },
            {
              id: "date",
              type: "date" as const,
              label: "Date",
              validation: { minDate: "2026-01-01", maxDate: "2026-12-31" },
            },
          ],
        },
      ],
    };

    const result = validateFormData(schema, {
      attachment: { name: "image.png", size: 10, type: "image/png" },
      choices: ["a"],
      count: 4,
      date: "2027-01-01",
    });

    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.fieldId)).toEqual(
      expect.arrayContaining(["attachment", "choices", "count", "date"]),
    );
  });

  it("should normalize scalar checkbox submissions into a single selection", () => {
    const schema = {
      steps: [
        {
          id: "step-1",
          title: "Step 1",
          fields: [
            {
              id: "choices",
              type: "checkbox" as const,
              label: "Choices",
              options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
              ],
              validation: { required: true },
            },
          ],
        },
      ],
    };

    const result = validateFormData(schema, { choices: "a" });

    expect(result.valid).toBe(true);
    expect(result.data).toMatchObject({ choices: ["a"] });
  });

  it("should sanitize sponsor schema fields", () => {
    const sponsorSchema = {
      sponsorSteps: [
        {
          id: "sponsor-step",
          fields: [{ id: "companyName", type: "text" as const }],
        },
      ],
      beneficiaryTemplate: {
        steps: [
          {
            id: "beneficiary-step",
            fields: [{ id: "beneficiaryEmail", type: "email" as const }],
          },
        ],
      },
    };

    expect(
      sanitizeFormData(sponsorSchema, {
        companyName: "Clinic",
        beneficiaryEmail: "doctor@example.com",
        injected: true,
      }),
    ).toEqual({
      companyName: "Clinic",
      beneficiaryEmail: "doctor@example.com",
    });

    expect(
      sanitizeFormData(
        { beneficiaryTemplate: sponsorSchema.beneficiaryTemplate },
        {
          beneficiaryEmail: "doctor@example.com",
          injected: true,
        },
      ),
    ).toEqual({ beneficiaryEmail: "doctor@example.com" });
  });

  it("should not accept file type substring matches", () => {
    const schema = {
      steps: [
        {
          id: "step-1",
          title: "Step 1",
          fields: [
            {
              id: "attachment",
              type: "file" as const,
              label: "Attachment",
              validation: { acceptedFileTypes: ["pdf"] },
            },
          ],
        },
      ],
    };

    expect(
      validateFormData(schema, {
        attachment: {
          name: "report.exe",
          size: 10,
          type: "application/pdf-malware",
        },
      }).valid,
    ).toBe(false);
  });
});

describe("validateFormData — field visibility follows the form app", () => {
  const field = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    type: "text" as const,
    label: id,
    ...extra,
  });
  const schemaOf = (...fields: Array<Record<string, unknown>>) => ({
    steps: [{ id: "s1", title: "Step", fields }],
  });
  const specialtySchema = schemaOf(
    field("specialty"),
    field("otherSpecialty", {
      required: true,
      conditions: [{ id: "c1", fieldId: "specialty", operator: "equals", value: "other" }],
    }),
  );

  it("requires and keeps a field the form shows through a case-insensitive match", () => {
    expect(
      validateFormData(specialtySchema, { specialty: "Other" }).errors.map((e) => e.fieldId),
    ).toEqual(["otherSpecialty"]);

    expect(
      validateFormData(specialtySchema, { specialty: "Other", otherSpecialty: "Nephro" }).data,
    ).toEqual({ specialty: "Other", otherSpecialty: "Nephro" });
  });

  it("neither requires nor keeps a field the form hides", () => {
    const result = validateFormData(specialtySchema, {
      specialty: "cardiology",
      otherSpecialty: "stale answer",
    });
    expect(result.valid).toBe(true);
    expect(result.data).toEqual({ specialty: "cardiology" });
  });

  it("evaluates uppercase AND as OR, like the form app", () => {
    const schema = schemaOf(
      field("a"),
      field("b"),
      field("both", {
        required: true,
        conditionLogic: "AND",
        conditions: [
          { id: "c1", fieldId: "a", operator: "equals", value: "1" },
          { id: "c2", fieldId: "b", operator: "equals", value: "2" },
        ],
      }),
    );
    // Only one condition holds: the form shows the field, so it is required.
    expect(validateFormData(schema, { a: "1", b: "x" }).errors.map((e) => e.fieldId)).toEqual([
      "both",
    ]);
    // Lowercase "and" needs both.
    const lower = schemaOf(
      field("a"),
      field("b"),
      field("both", {
        required: true,
        conditionLogic: "and",
        conditions: [
          { id: "c1", fieldId: "a", operator: "equals", value: "1" },
          { id: "c2", fieldId: "b", operator: "equals", value: "2" },
        ],
      }),
    );
    expect(validateFormData(lower, { a: "1", b: "x" }).valid).toBe(true);
  });

  it("hides a field whose condition references a field that does not exist", () => {
    const schema = schemaOf(
      field("detail", {
        required: true,
        conditions: [{ id: "c1", fieldId: "deleted", operator: "equals", value: "yes" }],
      }),
    );
    const result = validateFormData(schema, { detail: "kept?" });
    expect(result.valid).toBe(true);
    expect(result.data).toEqual({});
  });

  it("evaluates visibility on the submitted answers, including hidden ones", () => {
    // The form app does not cascade: a hidden field's answer still drives
    // the fields that depend on it.
    const schema = schemaOf(
      field("a"),
      field("b", { conditions: [{ id: "c1", fieldId: "a", operator: "equals", value: "yes" }] }),
      field("c", {
        required: true,
        conditions: [{ id: "c2", fieldId: "b", operator: "is_not_empty", value: "" }],
      }),
    );
    const result = validateFormData(schema, { a: "no", b: "stale" });
    expect(result.errors.map((e) => e.fieldId)).toEqual(["c"]);
  });

  it("rejects a condition the form app cannot evaluate", () => {
    const schema = schemaOf(
      field("age"),
      field("note", {
        conditions: [{ id: "c1", fieldId: "age", operator: "equals", value: 42 }],
      }),
    );
    const result = validateFormData(schema, { age: "42", note: "x" });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({ fieldId: "note", code: "invalid_condition" }),
    ]);
    // With no answer to compare, the form app does not throw either.
    expect(validateFormData(schema, { note: "x" }).valid).toBe(true);
  });
});

describe("validateFormData — enforceRequired: false (admin create/edit)", () => {
  const schema = {
    steps: [
      {
        id: "s1",
        title: "Step",
        fields: [
          { id: "name", type: "text" as const, label: "Name", required: true },
          {
            id: "track",
            type: "dropdown" as const,
            label: "Track",
            required: true,
            options: [{ id: "clinical" }, { id: "research" }],
          },
          {
            id: "topics",
            type: "checkbox" as const,
            label: "Topics",
            options: [{ id: "a" }, { id: "b" }, { id: "c" }],
            validation: { minSelections: 2 },
          },
          { id: "age", type: "number" as const, label: "Age" },
          {
            id: "lab",
            type: "text" as const,
            label: "Lab",
            required: true,
            conditions: [{ id: "c1", fieldId: "track", operator: "equals", value: "research" }],
          },
        ],
      },
    ],
  };
  const admin = { enforceRequired: false };

  it("accepts blank answers to required fields and keeps them as sent", () => {
    const result = validateFormData(schema, { name: "", track: null, topics: [] }, admin);
    expect(result.valid).toBe(true);
    expect(result.data).toEqual({ name: "", track: null, topics: [] });
    expect(validateFormData(schema, { name: "" }).valid).toBe(false);
  });

  it("still type-checks answers that are given, and coerces them", () => {
    expect(validateFormData(schema, { track: "unknown" }, admin).errors.map((e) => e.fieldId)).toEqual([
      "track",
    ]);
    expect(validateFormData(schema, { topics: ["a"] }, admin).valid).toBe(false);
    expect(validateFormData(schema, { name: " Ada ", age: "33" }, admin).data).toEqual({
      name: "Ada",
      age: 33,
    });
  });

  it("drops answers to fields the form hides", () => {
    expect(validateFormData(schema, { track: "clinical", lab: "stale" }, admin).data).toEqual({
      track: "clinical",
    });
  });
});
