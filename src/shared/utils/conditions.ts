/**
 * Shared condition evaluation logic used by pricing, access, and form validation.
 *
 * Design decisions:
 * - `equals`/`not_equals` coerce both sides to string before comparing, so
 *   a form data value of "42" matches a condition value of 42 (and vice versa).
 * - Unknown operators return `false` (fail closed).
 * - Empty condition arrays with AND logic return `true`; with OR logic return `false`.
 */

export interface Condition {
  fieldId: string;
  operator: string;
  value?: string | number | boolean | null;
}

/**
 * Evaluate a single condition against form data.
 */
export function evaluateSingleCondition(
  condition: Condition,
  formData: Record<string, unknown>,
): boolean {
  const value = formData[condition.fieldId];

  switch (condition.operator) {
    case "equals":
      return String(value ?? "") === String(condition.value ?? "");
    case "not_equals":
      return String(value ?? "") !== String(condition.value ?? "");
    case "contains":
      return (
        typeof value === "string" &&
        value.includes(String(condition.value ?? ""))
      );
    case "not_contains":
      return (
        typeof value !== "string" ||
        !value.includes(String(condition.value ?? ""))
      );
    case "greater_than":
      return typeof value === "number" && value > Number(condition.value);
    case "less_than":
      return typeof value === "number" && value < Number(condition.value);
    case "is_empty":
      return (
        !value || value === "" || (Array.isArray(value) && value.length === 0)
      );
    case "is_not_empty":
      return (
        !!value && value !== "" && !(Array.isArray(value) && value.length === 0)
      );
    default:
      return false; // Unknown operator — fail closed
  }
}

/**
 * Evaluate a list of conditions with AND or OR logic.
 * - Empty array + AND → true (vacuous truth)
 * - Empty array + OR → false (no condition satisfied)
 */
export function evaluateConditions(
  conditions: Condition[],
  logic: "AND" | "OR" | "and" | "or",
  formData: Record<string, unknown>,
): boolean {
  const normalizedLogic = logic.toUpperCase() as "AND" | "OR";
  if (conditions.length === 0) {
    return normalizedLogic === "AND"; // AND: true (no constraints); OR: false (nothing satisfied)
  }
  const results = conditions.map((c) => evaluateSingleCondition(c, formData));
  return normalizedLogic === "AND" ? results.every(Boolean) : results.some(Boolean);
}
