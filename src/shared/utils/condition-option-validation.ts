/**
 * Save-time guard against pricing/access rule conditions whose `value` is a
 * form field's option LABEL instead of its option ID.
 *
 * Option-bearing fields (dropdown/radio/checkbox/country/governorate) store
 * the submitted answer as an option ID (e.g. a `country` field stores "TN"),
 * never the label ("Tunisie"). The runtime evaluator in `./conditions.ts`
 * compares a condition's `value` against that stored ID with plain string
 * equality — it has no way to know "Tunisie" was meant to mean "TN", so a
 * rule authored with the label silently never matches (`equals`) or always
 * matches (`not_equals`) every submission. This module exists to catch that
 * mistake at save time, before a rule ever reaches `conditions.ts` — it
 * intentionally does NOT touch `conditions.ts`.
 *
 * Design decisions:
 * - Structurally typed, defensive walk of the form schema (`unknown` in,
 *   `Map` out) — mirrors `modules/forms/form-data-validator.ts`'s
 *   `extractSchemaSteps`. Never imports from `@forms`: this lives in
 *   `shared/` and is called from both the pricing and access modules, so it
 *   must stay free of any single module's types.
 * - Only fields that declare a non-empty `options` array enter the index —
 *   text/number/date/... fields have no option ids to check a condition
 *   value against, so conditions on them are always left alone.
 * - Only `equals`/`not_equals`/`in` are checked, and only when the value
 *   looks like it could BE an option id (a non-empty string, or for `in` an
 *   array containing at least one string element). Every other operator
 *   (`contains`, `greater_than`, `is_empty`, ...) and every other value
 *   shape (number, boolean, null, undefined, empty string) is left alone —
 *   those never carry an option id in the first place.
 * - Never throws: a malformed schema produces an empty index; malformed or
 *   unrecognized conditions are skipped rather than crashing the save path.
 */

import type { Condition } from "@shared/schemas/condition.schema.js";

const MAX_EXAMPLE_OPTION_IDS = 3;

export interface FieldOptionInfo {
  fieldLabel: string;
  optionIds: Set<string>;
  /** First few option ids, for error messages (e.g. "TN", "FR", "DZ"). */
  exampleOptionIds: string[];
}

export interface InvalidOptionCondition {
  fieldId: string;
  fieldLabel: string;
  operator: string;
  value: unknown;
  exampleOptionIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Walk `schema.steps[].fields[]` defensively and index every field that
 * declares a non-empty `options` array, keyed by field id.
 */
export function buildFieldOptionIndex(
  schema: unknown,
): Map<string, FieldOptionInfo> {
  const index = new Map<string, FieldOptionInfo>();
  if (!isRecord(schema) || !Array.isArray(schema.steps)) {
    return index;
  }

  for (const step of schema.steps) {
    if (!isRecord(step) || !Array.isArray(step.fields)) continue;

    for (const field of step.fields) {
      if (!isRecord(field)) continue;

      const fieldId = field.id;
      if (typeof fieldId !== "string" || fieldId === "") continue;
      if (!Array.isArray(field.options) || field.options.length === 0) {
        continue;
      }

      const optionIds: string[] = [];
      for (const option of field.options) {
        if (isRecord(option) && typeof option.id === "string" && option.id !== "") {
          optionIds.push(option.id);
        }
      }

      const fieldLabel =
        typeof field.label === "string" ? field.label : fieldId;

      index.set(fieldId, {
        fieldLabel,
        optionIds: new Set(optionIds),
        exampleOptionIds: optionIds.slice(0, MAX_EXAMPLE_OPTION_IDS),
      });
    }
  }

  return index;
}

/**
 * Find conditions whose `value` targets an option-bearing field but is not
 * one of that field's real option ids — the "authored the label instead of
 * the id" mistake this module exists to catch.
 *
 * Fields absent from `index` (unknown fieldId, or a field with no options)
 * are skipped, not flagged — this is a targeted option-id check, not a
 * general "does this field exist" validator.
 */
export function findInvalidOptionConditions(
  conditions: readonly Condition[],
  index: Map<string, FieldOptionInfo>,
): InvalidOptionCondition[] {
  if (!Array.isArray(conditions)) return [];

  const invalid: InvalidOptionCondition[] = [];

  for (const condition of conditions) {
    if (!isRecord(condition)) continue;

    const fieldId = condition.fieldId;
    if (typeof fieldId !== "string") continue;

    const fieldInfo = index.get(fieldId);
    if (!fieldInfo) continue; // Unknown field, or no options — not our concern.

    const operator = condition.operator;
    const value = condition.value;

    if (operator === "equals" || operator === "not_equals") {
      if (
        typeof value === "string" &&
        value !== "" &&
        !fieldInfo.optionIds.has(value)
      ) {
        invalid.push({
          fieldId,
          fieldLabel: fieldInfo.fieldLabel,
          operator,
          value,
          exampleOptionIds: fieldInfo.exampleOptionIds,
        });
      }
      continue;
    }

    if (operator === "in" && Array.isArray(value)) {
      const badValue = value.find(
        (element) =>
          typeof element === "string" && !fieldInfo.optionIds.has(element),
      );
      if (badValue !== undefined) {
        invalid.push({
          fieldId,
          fieldLabel: fieldInfo.fieldLabel,
          operator,
          value: badValue,
          exampleOptionIds: fieldInfo.exampleOptionIds,
        });
      }
      continue;
    }

    // Every other operator, and every other value shape, carries no option
    // id to check — left alone.
  }

  return invalid;
}
