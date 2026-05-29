/**
 * Shared condition evaluation logic used by pricing, access, and form validation.
 *
 * Design decisions:
 * - `equals`/`not_equals` coerce both sides to string before comparing, so
 *   a form data value of "42" matches a condition value of 42 (and vice versa).
 * - Numeric comparisons accept finite numbers and numeric strings. Other values
 *   fail closed instead of silently comparing as zero or NaN.
 * - Unknown operators and logic values return `false` (fail closed).
 * - Empty condition arrays with AND logic return `true`; with OR logic return `false`.
 */

export interface Condition {
  fieldId: string;
  operator: string;
  value?: string | number | boolean | null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function isEqualValue(actual: unknown, expected: unknown): boolean {
  if (expected === null) {
    return actual === null;
  }
  if (expected === undefined) {
    return actual === undefined;
  }
  if (actual === null || actual === undefined) {
    return false;
  }

  return String(actual) === String(expected);
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
      return isEqualValue(value, condition.value);
    case "not_equals":
      return !isEqualValue(value, condition.value);
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
    case "greater_than": {
      const actual = toFiniteNumber(value);
      const expected = toFiniteNumber(condition.value);
      return actual !== null && expected !== null && actual > expected;
    }
    case "less_than": {
      const actual = toFiniteNumber(value);
      const expected = toFiniteNumber(condition.value);
      return actual !== null && expected !== null && actual < expected;
    }
    case "is_empty":
      return isEmptyValue(value);
    case "is_not_empty":
      return !isEmptyValue(value);
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
  logic: string,
  formData: Record<string, unknown>,
): boolean {
  const normalizedLogic = logic.toUpperCase();
  if (normalizedLogic !== "AND" && normalizedLogic !== "OR") {
    return false;
  }

  if (conditions.length === 0) {
    return normalizedLogic === "AND"; // AND: true (no constraints); OR: false (nothing satisfied)
  }
  const results = conditions.map((c) => evaluateSingleCondition(c, formData));
  return normalizedLogic === "AND"
    ? results.every(Boolean)
    : results.some(Boolean);
}
