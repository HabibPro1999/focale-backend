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
