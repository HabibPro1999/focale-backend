/**
 * Field visibility — an exact port of the public form app's evaluator
 * (`form/src/lib/conditions.ts`, identical on the form repo's `develop` and
 * `main` branches, last changed in form commit 777295a).
 *
 * The server uses this ONLY to decide which form fields are shown (and so
 * validated, required and stored). Pricing and access rules use the strict
 * evaluator in `./conditions` (`evaluateRuleConditions`), which the form app's
 * pricing code mirrors separately.
 *
 * Everything below the type declarations is byte-for-byte the form app's code,
 * quirks included, so the server hides exactly the fields the form hides:
 * - only lowercase `'and'` means AND; uppercase `"AND"` (and anything else)
 *   is evaluated as OR;
 * - text comparisons are case-insensitive, and `equals`/`contains` look
 *   inside array (checkbox) values;
 * - a condition whose field does not exist compares against `undefined`;
 * - a non-string condition value throws a TypeError from `.toLowerCase()`
 *   when the referenced field holds a string or an array.
 * Fix a quirk in the form app first, then port the change here.
 */

// Local copies of the form app's `ConditionOperator` / `FieldCondition` types
// (`form/src/types/form.ts`). Stored schemas may hold other shapes at runtime
// (uppercase logic, non-string values); callers cast at the boundary.
export type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'is_empty'
  | 'is_not_empty'
  | 'greater_than'
  | 'less_than';

export interface FieldCondition {
  id: string;
  fieldId: string;
  operator: ConditionOperator;
  value: string;
}

// =============================================================================
// Main Evaluation Functions
// =============================================================================

/**
 * Evaluate all conditions for a field to determine visibility
 *
 * @param conditions - Array of conditions to evaluate
 * @param logic - 'and' requires ALL conditions to match, 'or' requires ANY condition
 * @param formData - Current form data to evaluate against
 * @returns true if field should be visible, false otherwise
 *
 * @example
 * // Field shown when specialty is "other"
 * const isVisible = evaluateConditions(
 *   [{ id: '1', fieldId: 'specialty', operator: 'equals', value: 'other' }],
 *   'and',
 *   { specialty: 'other' }
 * ); // true
 */
export function evaluateConditions(
  conditions: FieldCondition[] | undefined,
  logic: 'and' | 'or' = 'and',
  formData: Record<string, unknown>
): boolean {
  // No conditions means always visible
  if (!conditions || conditions.length === 0) {
    return true;
  }

  const results = conditions.map((condition) =>
    evaluateSingleCondition(condition, formData)
  );

  return logic === 'and' ? results.every((r) => r) : results.some((r) => r);
}

/**
 * Evaluate a single condition against form data
 *
 * @param condition - The condition to evaluate
 * @param formData - Current form data
 * @returns true if condition is satisfied
 */
export function evaluateSingleCondition(
  condition: FieldCondition,
  formData: Record<string, unknown>
): boolean {
  const fieldValue = formData[condition.fieldId];

  return evaluateOperator(condition.operator, fieldValue, condition.value);
}

// =============================================================================
// Operator Evaluation
// =============================================================================

/**
 * Evaluate a condition operator with given values
 *
 * @param operator - The comparison operator
 * @param fieldValue - The actual value from form data
 * @param conditionValue - The expected value from the condition
 * @returns true if the operator condition is satisfied
 */
export function evaluateOperator(
  operator: ConditionOperator,
  fieldValue: unknown,
  conditionValue: string
): boolean {
  switch (operator) {
    case 'equals':
      return isEqual(fieldValue, conditionValue);

    case 'not_equals':
      return !isEqual(fieldValue, conditionValue);

    case 'contains':
      return containsValue(fieldValue, conditionValue);

    case 'not_contains':
      return !containsValue(fieldValue, conditionValue);

    case 'is_empty':
      return isEmpty(fieldValue);

    case 'is_not_empty':
      return !isEmpty(fieldValue);

    case 'greater_than':
      return isGreaterThan(fieldValue, conditionValue);

    case 'less_than':
      return isLessThan(fieldValue, conditionValue);

    default:
      // Unknown operator — fail closed (match backend behavior)
      console.warn(`Unknown condition operator: ${operator}`);
      return false;
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check equality between field value and condition value
 * Handles arrays (checkbox values), strings, and numbers
 */
function isEqual(fieldValue: unknown, conditionValue: string): boolean {
  // Handle null/undefined
  if (fieldValue === null || fieldValue === undefined) {
    return conditionValue === '' || conditionValue === 'null' || conditionValue === 'undefined';
  }

  // Handle arrays (e.g., checkbox selections) - case-insensitive
  if (Array.isArray(fieldValue)) {
    // Check if condition value is in the array (case-insensitive)
    const lowerCondition = conditionValue.toLowerCase();
    return fieldValue.some((v) => String(v).toLowerCase() === lowerCondition);
  }

  // Handle boolean
  if (typeof fieldValue === 'boolean') {
    return fieldValue === (conditionValue === 'true');
  }

  // Handle numbers
  if (typeof fieldValue === 'number') {
    return fieldValue === Number(conditionValue);
  }

  // Handle strings (case-insensitive comparison)
  return String(fieldValue).toLowerCase() === conditionValue.toLowerCase();
}

/**
 * Check if field value contains the condition value
 * Works with strings and arrays
 */
function containsValue(fieldValue: unknown, conditionValue: string): boolean {
  if (fieldValue === null || fieldValue === undefined) {
    return false;
  }

  // Handle arrays
  if (Array.isArray(fieldValue)) {
    return fieldValue.some((v) =>
      String(v).toLowerCase().includes(conditionValue.toLowerCase())
    );
  }

  // Handle strings
  return String(fieldValue).toLowerCase().includes(conditionValue.toLowerCase());
}

/**
 * Check if a value is empty
 * Empty means: null, undefined, empty string, empty array
 */
function isEmpty(fieldValue: unknown): boolean {
  if (fieldValue === null || fieldValue === undefined) {
    return true;
  }

  if (typeof fieldValue === 'string') {
    return fieldValue.trim() === '';
  }

  if (Array.isArray(fieldValue)) {
    return fieldValue.length === 0;
  }

  return false;
}

/**
 * Check if field value is greater than condition value
 * Compares as numbers
 */
function isGreaterThan(fieldValue: unknown, conditionValue: string): boolean {
  const numField = Number(fieldValue);
  const numCondition = Number(conditionValue);

  if (isNaN(numField) || isNaN(numCondition)) {
    // Fall back to string comparison for dates
    if (typeof fieldValue === 'string') {
      return fieldValue > conditionValue;
    }
    return false;
  }

  return numField > numCondition;
}

/**
 * Check if field value is less than condition value
 * Compares as numbers
 */
function isLessThan(fieldValue: unknown, conditionValue: string): boolean {
  const numField = Number(fieldValue);
  const numCondition = Number(conditionValue);

  if (isNaN(numField) || isNaN(numCondition)) {
    // Fall back to string comparison for dates
    if (typeof fieldValue === 'string') {
      return fieldValue < conditionValue;
    }
    return false;
  }

  return numField < numCondition;
}

// =============================================================================
// Batch Evaluation
// =============================================================================

/**
 * Get all visible field IDs based on current form data
 *
 * @param fields - Array of fields with their conditions
 * @param formData - Current form data
 * @returns Set of visible field IDs
 */
export function getVisibleFieldIds(
  fields: Array<{
    id: string;
    conditions?: FieldCondition[];
    conditionLogic?: 'and' | 'or';
  }>,
  formData: Record<string, unknown>
): Set<string> {
  const visible = new Set<string>();

  for (const field of fields) {
    if (evaluateConditions(field.conditions, field.conditionLogic, formData)) {
      visible.add(field.id);
    }
  }

  return visible;
}

/**
 * Filter form data to only include visible fields
 * Useful when submitting to remove hidden field values
 *
 * @param formData - Full form data
 * @param visibleFieldIds - Set of visible field IDs
 * @returns Filtered form data with only visible fields
 */
export function filterVisibleFormData(
  formData: Record<string, unknown>,
  visibleFieldIds: Set<string>
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(formData)) {
    if (visibleFieldIds.has(key)) {
      filtered[key] = value;
    }
  }

  return filtered;
}
