// ============================================================================
// Condition Evaluation Utility
// ============================================================================

/**
 * Shared condition evaluation logic for pricing rules and form field validation.
 * @see pure-form/src/lib/conditions.ts -- these implementations must stay in sync
 */

// ============================================================================
// Types
// ============================================================================

export interface EvaluableCondition {
  fieldId: string;
  operator: string;
  value?: string | number | boolean;
}

export interface EvaluateConditionsOptions {
  /**
   * Default value to return when an unknown operator is encountered.
   * - `false` (default): strict mode, reject unknown operators
   * - `true`: permissive mode, allow unknown operators
   */
  unknownOperatorDefault?: boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

export function isEqual(fieldValue: unknown, conditionValue: string): boolean {
  // Handle null/undefined
  if (fieldValue === null || fieldValue === undefined) {
    return (
      conditionValue === "" ||
      conditionValue === "null" ||
      conditionValue === "undefined"
    );
  }

  // Handle arrays (e.g., checkbox selections) - case-insensitive
  if (Array.isArray(fieldValue)) {
    const lowerCondition = conditionValue.toLowerCase();
    return fieldValue.some((v) => String(v).toLowerCase() === lowerCondition);
  }

  // Handle boolean
  if (typeof fieldValue === "boolean") {
    return fieldValue === (conditionValue === "true");
  }

  // Handle numbers
  if (typeof fieldValue === "number") {
    return fieldValue === Number(conditionValue);
  }

  // Handle strings (case-insensitive comparison)
  return String(fieldValue).toLowerCase() === conditionValue.toLowerCase();
}

export function containsValue(
  fieldValue: unknown,
  conditionValue: string,
): boolean {
  if (fieldValue === null || fieldValue === undefined) {
    return false;
  }

  // Handle arrays
  if (Array.isArray(fieldValue)) {
    return fieldValue.some((v) =>
      String(v).toLowerCase().includes(conditionValue.toLowerCase()),
    );
  }

  // Handle strings
  return String(fieldValue)
    .toLowerCase()
    .includes(conditionValue.toLowerCase());
}

export function isEmpty(fieldValue: unknown): boolean {
  if (fieldValue === null || fieldValue === undefined) {
    return true;
  }

  if (typeof fieldValue === "string") {
    return fieldValue.trim() === "";
  }

  if (Array.isArray(fieldValue)) {
    return fieldValue.length === 0;
  }

  return false;
}

export function isGreaterThan(
  fieldValue: unknown,
  conditionValue: string,
): boolean {
  if (fieldValue === null || fieldValue === undefined) {
    return false;
  }

  const numField = Number(fieldValue);
  const numCondition = Number(conditionValue);

  if (isNaN(numField) || isNaN(numCondition)) {
    // Fall back to string comparison for dates
    if (typeof fieldValue === "string") {
      return fieldValue > conditionValue;
    }
    return false;
  }

  return numField > numCondition;
}

export function isLessThan(
  fieldValue: unknown,
  conditionValue: string,
): boolean {
  if (fieldValue === null || fieldValue === undefined) {
    return false;
  }

  const numField = Number(fieldValue);
  const numCondition = Number(conditionValue);

  if (isNaN(numField) || isNaN(numCondition)) {
    // Fall back to string comparison for dates
    if (typeof fieldValue === "string") {
      return fieldValue < conditionValue;
    }
    return false;
  }

  return numField < numCondition;
}

// ============================================================================
// Condition Evaluation
// ============================================================================

/**
 * Evaluate a single condition against form data.
 */
export function evaluateSingleCondition(
  condition: EvaluableCondition,
  formData: Record<string, unknown>,
  options?: EvaluateConditionsOptions,
): boolean {
  const fieldValue = formData[condition.fieldId];
  const conditionValue = String(condition.value ?? "");
  const unknownDefault = options?.unknownOperatorDefault ?? false;

  switch (condition.operator) {
    case "equals":
      return isEqual(fieldValue, conditionValue);
    case "not_equals":
      return !isEqual(fieldValue, conditionValue);
    case "contains":
      return containsValue(fieldValue, conditionValue);
    case "not_contains":
      return !containsValue(fieldValue, conditionValue);
    case "greater_than":
      return isGreaterThan(fieldValue, conditionValue);
    case "less_than":
      return isLessThan(fieldValue, conditionValue);
    case "is_empty":
      return isEmpty(fieldValue);
    case "is_not_empty":
      return !isEmpty(fieldValue);
    default:
      return unknownDefault;
  }
}

/**
 * Evaluate multiple conditions with AND/OR logic.
 */
export function evaluateConditions(
  conditions: EvaluableCondition[],
  logic: "and" | "or",
  formData: Record<string, unknown>,
  options?: EvaluateConditionsOptions,
): boolean {
  const results = conditions.map((c) =>
    evaluateSingleCondition(c, formData, options),
  );
  return logic === "and" ? results.every(Boolean) : results.some(Boolean);
}
