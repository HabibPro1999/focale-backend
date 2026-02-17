import { describe, it, expect } from "vitest";
import { shouldValidateField } from "./form-data-validator.js";
import type { FormField } from "@forms";

// Helper to create minimal FormField for testing
function createField(
  overrides: Partial<FormField> = {},
): FormField & { conditionLogic?: "AND" | "OR" } {
  return {
    id: "test-field",
    type: "text",
    label: "Test Field",
    required: false,
    ...overrides,
  } as FormField & { conditionLogic?: "AND" | "OR" };
}

describe("Form Data Validator - shouldValidateField Integration", () => {
  const allFields: FormField[] = [
    {
      id: "profession",
      type: "dropdown",
      label: "Profession",
      required: true,
    } as FormField,
    {
      id: "specialty",
      type: "text",
      label: "Specialty",
      required: false,
    } as FormField,
    {
      id: "age",
      type: "number",
      label: "Age",
      required: false,
    } as FormField,
    {
      id: "tags",
      type: "checkbox",
      label: "Tags",
      required: false,
    } as FormField,
    {
      id: "notes",
      type: "textarea",
      label: "Notes",
      required: false,
    } as FormField,
  ];

  describe("conditionLogic: AND", () => {
    it("should require all conditions to be met", () => {
      const field = createField({
        id: "conditional-field",
        conditionLogic: "AND",
        conditions: [
          { fieldId: "profession", operator: "equals", value: "doctor" },
          { fieldId: "age", operator: "greater_than", value: "25" },
        ],
      });

      // Both conditions met
      expect(
        shouldValidateField(
          field,
          { profession: "doctor", age: 30 },
          allFields,
        ),
      ).toBe(true);

      // Only first condition met
      expect(
        shouldValidateField(
          field,
          { profession: "doctor", age: 20 },
          allFields,
        ),
      ).toBe(false);

      // Only second condition met
      expect(
        shouldValidateField(field, { profession: "nurse", age: 30 }, allFields),
      ).toBe(false);

      // Neither condition met
      expect(
        shouldValidateField(field, { profession: "nurse", age: 20 }, allFields),
      ).toBe(false);
    });
  });

  describe("conditionLogic: OR", () => {
    it("should require at least one condition to be met", () => {
      const field = createField({
        id: "conditional-field",
        conditionLogic: "OR",
        conditions: [
          { fieldId: "profession", operator: "equals", value: "doctor" },
          { fieldId: "profession", operator: "equals", value: "nurse" },
        ],
      });

      // First condition met
      expect(
        shouldValidateField(field, { profession: "doctor" }, allFields),
      ).toBe(true);

      // Second condition met
      expect(
        shouldValidateField(field, { profession: "nurse" }, allFields),
      ).toBe(true);

      // Neither condition met
      expect(
        shouldValidateField(field, { profession: "pharmacist" }, allFields),
      ).toBe(false);
    });
  });

  describe("no conditions", () => {
    it("should always validate field when no conditions are defined", () => {
      const field = createField({
        id: "unconditional-field",
        conditions: undefined,
      });

      expect(shouldValidateField(field, {}, allFields)).toBe(true);
      expect(
        shouldValidateField(field, { profession: "anything" }, allFields),
      ).toBe(true);
    });

    it("should always validate field when conditions array is empty", () => {
      const field = createField({
        id: "unconditional-field",
        conditions: [],
      });

      expect(shouldValidateField(field, {}, allFields)).toBe(true);
    });
  });

  describe("missing target field", () => {
    it("should assume condition is met when target field does not exist", () => {
      const field = createField({
        id: "conditional-field",
        conditions: [
          { fieldId: "nonexistent-field", operator: "equals", value: "test" },
        ],
      });

      expect(shouldValidateField(field, {}, allFields)).toBe(true);
    });
  });
});
