// ============================================================================
// Form Helper Utilities
// ============================================================================

/**
 * Lightweight field condition type used for working with raw JSONB form data.
 * Less strict than the full FieldCondition Zod type — used for casting
 * unvalidated schema data from the database.
 */
export type FieldCondition = {
  fieldId: string;
  operator: string;
  value?: string | number | boolean;
};

/**
 * Lightweight form field type used for working with raw JSONB form data.
 */
export type FormField = {
  id: string;
  type: string;
  label?: string;
  options?: Array<{ id: string; label: string; value?: string }>;
  conditions?: FieldCondition[];
};

/**
 * Lightweight form schema type used for casting raw JSONB form data from the database.
 */
export type FormSchemaSteps = {
  steps: Array<{ fields: FormField[] }>;
};

// ============================================================================
// Specify-Other Helpers
// ============================================================================

/**
 * Option or condition values that indicate an "other / specify" selection.
 */
export const SPECIFY_OTHER_TRIGGER_VALUES = ["other", "autre", "other_diet"];

/**
 * Find a "specify other" child field for a given parent field.
 * Returns the child field that:
 * - Has conditions referencing the parent field
 * - Uses 'equals' operator with an "other" value
 */
export function findSpecifyOtherChild(
  parentField: FormField,
  allFields: FormField[],
): FormField | null {
  // Only for selection fields
  if (!["dropdown", "radio"].includes(parentField.type)) return null;

  // Check if parent has an "other" option (by option.id)
  const hasOtherOption = parentField.options?.some((opt) =>
    SPECIFY_OTHER_TRIGGER_VALUES.includes(opt.id.toLowerCase()),
  );
  if (!hasOtherOption) return null;

  // Find child field that depends on this parent with equals/other condition
  return (
    allFields.find((child) =>
      child.conditions?.some(
        (cond) =>
          cond.fieldId === parentField.id &&
          cond.operator === "equals" &&
          SPECIFY_OTHER_TRIGGER_VALUES.includes(
            String(cond.value ?? "").toLowerCase(),
          ),
      ),
    ) ?? null
  );
}
