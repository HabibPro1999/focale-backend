import { describe, it, expect } from "vitest";
import { shouldValidateField } from "./form-data-validator.js";
import type { FormField } from "@forms";

// Helper to create minimal FormField for testing
function createField(
  overrides: Partial<FormField> = {},
): FormField & { conditionLogic?: "and" | "or" } {
  return {
    id: "test-field",
    type: "text",
    label: "Test Field",
    required: false,
    ...overrides,
  } as FormField & { conditionLogic?: "and" | "or" };
}

describe("Form Data Validator - Condition Evaluation", () => {
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

  describe("isEqual operator", () => {
    it("should match exact string values (case-insensitive)", () => {
      const field = createField({
        id: "conditional-field",
        conditions: [
          { fieldId: "profession", operator: "equals", value: "doctor" },
        ],
      });

      expect(
        shouldValidateField(field, { profession: "doctor" }, allFields),
      ).toBe(true);
      expect(
        shouldValidateField(field, { profession: "Doctor" }, allFields),
      ).toBe(true);
      expect(
        shouldValidateField(field, { profession: "DOCTOR" }, allFields),
      ).toBe(true);
      expect(
        shouldValidateField(field, { profession: "nurse" }, allFields),
      ).toBe(false);
    });

    it("should match array values (checkbox selections)", () => {
      const field = createField({
        id: "conditional-field",
        conditions: [{ fieldId: "tags", operator: "equals", value: "urgent" }],
      });

      expect(
        shouldValidateField(
          field,
          { tags: ["urgent", "important"] },
          allFields,
        ),
      ).toBe(true);
      expect(shouldValidateField(field, { tags: ["Urgent"] }, allFields)).toBe(
        true,
      );
      expect(shouldValidateField(field, { tags: ["normal"] }, allFields)).toBe(
        false,
      );
    });

    it("should handle null/undefined values", () => {
      const field = createField({
        id: "conditional-field",
        conditions: [{ fieldId: "specialty", operator: "equals", value: "" }],
      });

      expect(shouldValidateField(field, { specialty: null }, allFields)).toBe(
        true,
      );
      expect(
        shouldValidateField(field, { specialty: undefined }, allFields),
      ).toBe(true);
      expect(shouldValidateField(field, {}, allFields)).toBe(true);
    });

    it("should match boolean values", () => {
      const boolField: FormField = {
        id: "isActive",
        type: "checkbox",
        label: "Active",
        required: false,
      } as FormField;

      const field = createField({
        id: "conditional-field",
        conditions: [
          { fieldId: "isActive", operator: "equals", value: "true" },
        ],
      });

      expect(
        shouldValidateField(field, { isActive: true }, [
          ...allFields,
          boolField,
        ]),
      ).toBe(true);
      expect(
        shouldValidateField(field, { isActive: false }, [
          ...allFields,
          boolField,
        ]),
      ).toBe(false);
    });

    it("should match numeric values", () => {
      const field = createField({
        id: "conditional-field",
        conditions: [{ fieldId: "age", operator: "equals", value: "30" }],
      });

      expect(shouldValidateField(field, { age: 30 }, allFields)).toBe(true);
      expect(shouldValidateField(field, { age: 25 }, allFields)).toBe(false);
    });
  });

  describe("containsValue operator", () => {
    it("should match substring in string (case-insensitive)", () => {
      const field = createField({
        id: "conditional-field",
        conditions: [
          { fieldId: "specialty", operator: "contains", value: "cardio" },
        ],
      });

      expect(
        shouldValidateField(field, { specialty: "cardiology" }, allFields),
      ).toBe(true);
      expect(
        shouldValidateField(field, { specialty: "Cardiology" }, allFields),
      ).toBe(true);
      expect(
        shouldValidateField(field, { specialty: "neurology" }, allFields),
      ).toBe(false);
    });

    it("should match substring in array values", () => {
      const field = createField({
        id: "conditional-field",
        conditions: [{ fieldId: "tags", operator: "contains", value: "urg" }],
      });

      expect(
        shouldValidateField(
          field,
          { tags: ["urgent", "important"] },
          allFields,
        ),
      ).toBe(true);
      expect(shouldValidateField(field, { tags: ["normal"] }, allFields)).toBe(
        false,
      );
    });

    it("should return false for null/undefined", () => {
      const field = createField({
        id: "conditional-field",
        conditions: [
          { fieldId: "specialty", operator: "contains", value: "cardio" },
        ],
      });

      expect(shouldValidateField(field, { specialty: null }, allFields)).toBe(
        false,
      );
      expect(shouldValidateField(field, {}, allFields)).toBe(false);
    });
  });

  describe("isEmpty operator", () => {
    it("should detect empty strings", () => {
      const field = createField({
        id: "conditional-field",
        conditions: [{ fieldId: "notes", operator: "is_empty", value: "" }],
      });

      expect(shouldValidateField(field, { notes: "" }, allFields)).toBe(true);
      expect(shouldValidateField(field, { notes: "   " }, allFields)).toBe(
        true,
      );
      expect(
        shouldValidateField(field, { notes: "some text" }, allFields),
      ).toBe(false);
    });

    it("should detect empty arrays", () => {
      const field = createField({
        id: "conditional-field",
        conditions: [{ fieldId: "tags", operator: "is_empty", value: "" }],
      });

      expect(shouldValidateField(field, { tags: [] }, allFields)).toBe(true);
      expect(shouldValidateField(field, { tags: ["item"] }, allFields)).toBe(
        false,
      );
    });

    it("should treat null/undefined as empty", () => {
      const field = createField({
        id: "conditional-field",
        conditions: [{ fieldId: "notes", operator: "is_empty", value: "" }],
      });

      expect(shouldValidateField(field, { notes: null }, allFields)).toBe(true);
      expect(shouldValidateField(field, { notes: undefined }, allFields)).toBe(
        true,
      );
      expect(shouldValidateField(field, {}, allFields)).toBe(true);
    });
  });

  describe("isGreaterThan operator", () => {
    it("should compare numeric values", () => {
      const field = createField({
        id: "conditional-field",
        conditions: [{ fieldId: "age", operator: "greater_than", value: "25" }],
      });

      expect(shouldValidateField(field, { age: 30 }, allFields)).toBe(true);
      expect(shouldValidateField(field, { age: 25 }, allFields)).toBe(false);
      expect(shouldValidateField(field, { age: 20 }, allFields)).toBe(false);
    });

    it("should fall back to string comparison for non-numeric", () => {
      const dateField: FormField = {
        id: "startDate",
        type: "date",
        label: "Start Date",
        required: false,
      } as FormField;

      const field = createField({
        id: "conditional-field",
        conditions: [
          {
            fieldId: "startDate",
            operator: "greater_than",
            value: "2025-01-01",
          },
        ],
      });

      expect(
        shouldValidateField(field, { startDate: "2025-06-01" }, [
          ...allFields,
          dateField,
        ]),
      ).toBe(true);
      expect(
        shouldValidateField(field, { startDate: "2024-12-01" }, [
          ...allFields,
          dateField,
        ]),
      ).toBe(false);
    });
  });

  describe("isLessThan operator", () => {
    it("should compare numeric values", () => {
      const field = createField({
        id: "conditional-field",
        conditions: [{ fieldId: "age", operator: "less_than", value: "30" }],
      });

      expect(shouldValidateField(field, { age: 25 }, allFields)).toBe(true);
      expect(shouldValidateField(field, { age: 30 }, allFields)).toBe(false);
      expect(shouldValidateField(field, { age: 35 }, allFields)).toBe(false);
    });

    it("should fall back to string comparison for non-numeric", () => {
      const dateField: FormField = {
        id: "endDate",
        type: "date",
        label: "End Date",
        required: false,
      } as FormField;

      const field = createField({
        id: "conditional-field",
        conditions: [
          { fieldId: "endDate", operator: "less_than", value: "2025-12-31" },
        ],
      });

      expect(
        shouldValidateField(field, { endDate: "2025-06-01" }, [
          ...allFields,
          dateField,
        ]),
      ).toBe(true);
      expect(
        shouldValidateField(field, { endDate: "2026-01-01" }, [
          ...allFields,
          dateField,
        ]),
      ).toBe(false);
    });
  });

  describe("conditionLogic: AND", () => {
    it("should require all conditions to be met", () => {
      const field = createField({
        id: "conditional-field",
        conditionLogic: "and",
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
        conditionLogic: "or",
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
