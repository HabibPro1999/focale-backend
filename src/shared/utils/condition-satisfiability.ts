/**
 * Contradiction guard for pricing/access conditions.
 *
 * Detects groups of conditions on the SAME `fieldId`, combined with AND, that
 * can never all be true at once - e.g. three `equals` conditions stacked on
 * one dropdown ("category is phd AND category is resident AND category is
 * postgrad"), which is exactly the class of dead pricing rule this guard
 * exists to catch before it ships. `condition-satisfiability.test.ts` is the
 * shared spec this file (and its twin) must satisfy.
 *
 * Admin twin: `admin/src/lib/condition-satisfiability.ts` - byte-identical
 * except this header comment. `Condition` and `toFiniteNumber` are declared
 * LOCALLY below (not imported from `./conditions.js`) so the two files stay
 * copy-paste identical across repos with no shared package - same trick
 * `form/src/lib/pricing-conditions.ts` already uses to mirror
 * `backend/src/shared/utils/conditions.ts`.
 *
 * Tier 1 rules (equals/equals, equals/not_equals, is_empty/is_not_empty,
 * is_empty/equals, greater_than/less_than, contains/not_contains, `in []`,
 * equals/in) are type-free and provable with zero form-schema knowledge - run
 * here AND in admin, and also enforced backend-side in
 * `pricing.service.ts`/`pricing.schema.ts`.
 *
 * Tier 3 (`in`/`in` with disjoint lists) additionally needs to know whether a
 * field is single- or multi-valued: on a checkbox, `in A` + `in B` is a
 * legitimate "at least one of A AND at least one of B", not a contradiction.
 * It is gated behind the optional `singleValuedFieldIds` option. The backend
 * has no form schema and intentionally NEVER passes this option - this
 * asymmetry is permanent, not a TODO to "fix" into parity.
 *
 * Never throws: unknown/future operators and malformed stored condition
 * shapes return no conflict rather than throwing, because stored condition
 * JSON is never re-validated on read (it is cast, not parsed).
 *
 * Biased hard against false positives - rejecting a rule someone legitimately
 * wants is worse than missing an exotic contradiction. Deliberately NOT
 * flagged: anything across different fieldIds (no cross-field inference,
 * ever); anything under OR; `equals A` + `equals A` (redundant, not
 * contradictory); `is_not_empty` + `equals ""` (satisfiable - an actual value
 * of `[""]` passes both); integer-domain gaps like `greater_than 1` +
 * `less_than 2`; `equals 300` vs `equals "300"` (same string key).
 */

interface Condition {
  fieldId: string;
  operator: string;
  value?: string | number | boolean | null | string[];
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

export type ConflictReason =
  | "equals_conflict"
  | "equals_not_equals_conflict"
  | "empty_conflict"
  | "empty_equals_conflict"
  | "range_conflict"
  | "contains_conflict"
  | "empty_in_conflict"
  | "equals_in_conflict"
  | "in_in_conflict";

export interface ConditionConflict {
  reason: ConflictReason;
  fieldId: string;
  /** Indices into the input `conditions` array - for painting inline errors. */
  indices: number[];
  /** The `value` of each condition referenced by `indices`, same order. */
  values: unknown[];
}

export interface FindConditionConflictsOptions {
  /**
   * Field ids known to hold at most one value (e.g. dropdown/radio), as
   * opposed to multi-valued fields (e.g. checkbox). Only used by Tier 3
   * (`in` vs `in`). Backend callers never pass this - see file header.
   */
  singleValuedFieldIds?: ReadonlySet<string>;
}

/**
 * Mirrors `isEqualValue`'s equivalence classes from `conditions.ts`:
 * - `null` only equals `null`.
 * - `undefined` only equals `undefined`.
 * - Everything else is compared via `String()`.
 *
 * Two values with the same key are exactly the values `isEqualValue` would
 * consider equal to each other.
 */
type ValueKey =
  | { kind: "null" }
  | { kind: "undefined" }
  | { kind: "value"; key: string };

function valueKey(value: unknown): ValueKey {
  if (value === null) return { kind: "null" };
  if (value === undefined) return { kind: "undefined" };
  return { kind: "value", key: String(value) };
}

function sameKey(a: unknown, b: unknown): boolean {
  const ka = valueKey(a);
  const kb = valueKey(b);
  if (ka.kind !== kb.kind) return false;
  return ka.kind === "value" && kb.kind === "value" ? ka.key === kb.key : true;
}

/** `equals E` is satisfiable together with `is_empty` only for these literals. */
function isEmptyLiteral(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/**
 * Coerces a condition's `in` value to a plain string array, defensively.
 * Malformed/legacy data (non-array, or an array with non-string entries)
 * degrades to an empty list rather than throwing.
 */
function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * Rule 8: `equals X` + `in L` conflict when `X` cannot be a member of `L`
 * under `isInValue`'s coercion, AND `String(X)` has no comma.
 *
 * The comma side-condition is load-bearing: `String(arr)` contains a comma
 * whenever `arr.length >= 2` (join always emits the literal separator), so a
 * comma-free `X` forces any array actual whose string image equals `X` to
 * have at most one element. That collapses "does some actual satisfy both
 * `equals X` and `in L`" down to "is X's key present in L's keys" - exactly
 * what we check. A comma-containing `X` could in principle be produced by a
 * multi-element array actual containing an `in`-listed element, so this rule
 * self-disables rather than risk a false positive.
 */
function equalsInConflicts(equalsValue: unknown, inValue: unknown): boolean {
  if (equalsValue === null || equalsValue === undefined) return false;
  const key = String(equalsValue);
  if (key.includes(",")) return false;

  const list = toStringList(inValue);
  if (list.length === 0) return false; // handled separately by rule 7

  return !list.some((c) => sameKey(equalsValue, c));
}

/** Rule 13 (Tier 3): disjoint `in` lists on a known single-valued field. */
function inInDisjoint(a: unknown, b: unknown): boolean {
  const listA = toStringList(a);
  const listB = toStringList(b);
  if (listA.length === 0 || listB.length === 0) return false;

  const keysB = new Set(listB.map((v) => String(v)));
  return !listA.some((v) => keysB.has(String(v)));
}

/**
 * Tier 1 pairwise check between two conditions already known to share a
 * `fieldId` and to be combined with AND. Order of `a`/`b` does not matter.
 */
function checkTier1Pair(a: Condition, b: Condition): ConflictReason | null {
  const opA = a.operator;
  const opB = b.operator;

  // Rule 3: is_empty + is_not_empty - direct negation, always contradictory.
  if (
    (opA === "is_empty" && opB === "is_not_empty") ||
    (opA === "is_not_empty" && opB === "is_empty")
  ) {
    return "empty_conflict";
  }

  // Rule 4: is_empty + equals E, E not an empty literal.
  if (opA === "is_empty" && opB === "equals" && !isEmptyLiteral(b.value)) {
    return "empty_equals_conflict";
  }
  if (opB === "is_empty" && opA === "equals" && !isEmptyLiteral(a.value)) {
    return "empty_equals_conflict";
  }

  // Rule 1: equals A + equals B, different keys.
  if (opA === "equals" && opB === "equals" && !sameKey(a.value, b.value)) {
    return "equals_conflict";
  }

  // Rule 2: equals A + not_equals B, same key.
  if (
    ((opA === "equals" && opB === "not_equals") ||
      (opA === "not_equals" && opB === "equals")) &&
    sameKey(a.value, b.value)
  ) {
    return "equals_not_equals_conflict";
  }

  // Rule 5: greater_than a + less_than b, both finite and a >= b.
  if (
    (opA === "greater_than" && opB === "less_than") ||
    (opA === "less_than" && opB === "greater_than")
  ) {
    const gVal = opA === "greater_than" ? a.value : b.value;
    const lVal = opA === "less_than" ? a.value : b.value;
    const g = toFiniteNumber(gVal);
    const l = toFiniteNumber(lVal);
    if (g !== null && l !== null && g >= l) {
      return "range_conflict";
    }
  }

  // Rule 6: contains S1 + not_contains S2, S1 contains S2 as a substring.
  if (opA === "contains" && opB === "not_contains") {
    if (String(a.value ?? "").includes(String(b.value ?? ""))) {
      return "contains_conflict";
    }
  }
  if (opB === "contains" && opA === "not_contains") {
    if (String(b.value ?? "").includes(String(a.value ?? ""))) {
      return "contains_conflict";
    }
  }

  // Rule 8: equals X + in L.
  if (
    opA === "equals" &&
    opB === "in" &&
    equalsInConflicts(a.value, b.value)
  ) {
    return "equals_in_conflict";
  }
  if (
    opB === "equals" &&
    opA === "in" &&
    equalsInConflicts(b.value, a.value)
  ) {
    return "equals_in_conflict";
  }

  return null;
}

/**
 * Find contradictions within a set of conditions combined by `logic`.
 *
 * Only conditions sharing the same `fieldId`, under `AND`, are ever compared
 * - see the header for the full "deliberately not flagged" list. Returns an
 * empty array under `OR` (an early return, not per-pair evaluation - running
 * these checks under OR would be actively wrong: `equals A OR equals B` is
 * the correct way to express "one of").
 *
 * Never throws.
 */
export function findConditionConflicts(
  conditions: readonly Condition[],
  logic: string,
  options?: FindConditionConflictsOptions,
): ConditionConflict[] {
  try {
    if (!Array.isArray(conditions) || conditions.length === 0) return [];
    if (typeof logic !== "string" || logic.toUpperCase() !== "AND") return [];

    const conflicts: ConditionConflict[] = [];

    // Rule 7: a single `in` condition with an EMPTY ARRAY value can never match
    // anything, standalone - defence-in-depth (the schema already blocks new
    // ones, but stored data is never re-validated on read).
    //
    // A non-array value is deliberately NOT flagged: `isInValue` degrades a
    // scalar to a one-element list, so `in "a"` behaves exactly like
    // `equals "a"` and IS satisfiable. Flagging it would be a false positive
    // against the evaluator this guard must mirror.
    conditions.forEach((condition, index) => {
      if (
        condition?.operator === "in" &&
        Array.isArray(condition.value) &&
        condition.value.length === 0
      ) {
        conflicts.push({
          reason: "empty_in_conflict",
          fieldId: condition.fieldId,
          indices: [index],
          values: [condition.value],
        });
      }
    });

    // Group condition indices by fieldId; only same-field pairs are compared.
    const byField = new Map<string, number[]>();
    conditions.forEach((condition, index) => {
      const fieldId = condition?.fieldId;
      if (typeof fieldId !== "string" || fieldId === "") return;
      const existing = byField.get(fieldId);
      if (existing) {
        existing.push(index);
      } else {
        byField.set(fieldId, [index]);
      }
    });

    for (const [fieldId, indices] of byField) {
      for (let i = 0; i < indices.length; i++) {
        for (let j = i + 1; j < indices.length; j++) {
          const idxA = indices[i];
          const idxB = indices[j];
          const a = conditions[idxA];
          const b = conditions[idxB];

          const tier1Reason = checkTier1Pair(a, b);
          if (tier1Reason) {
            conflicts.push({
              reason: tier1Reason,
              fieldId,
              indices: [idxA, idxB],
              values: [a.value, b.value],
            });
            continue;
          }

          // Tier 3, rule 13 - opt-in only, backend never passes this.
          if (
            options?.singleValuedFieldIds?.has(fieldId) &&
            a.operator === "in" &&
            b.operator === "in" &&
            inInDisjoint(a.value, b.value)
          ) {
            conflicts.push({
              reason: "in_in_conflict",
              fieldId,
              indices: [idxA, idxB],
              values: [a.value, b.value],
            });
          }
        }
      }
    }

    return conflicts;
  } catch {
    // Malformed/unexpected input must never surface as a crash - a guard
    // that throws is worse than a guard that misses a conflict.
    return [];
  }
}

/**
 * Canonical per-value key for the signature below. Normalizes scalars via
 * `String()` so `300` and `"300"` produce the same key (RuleEditor
 * round-trips numbers through `String()` on save). `null`/`undefined`/arrays
 * each get a distinct tag so they can never collide with a scalar's string
 * image (e.g. the string value `"null"` is not the same key as the literal
 * `null`).
 */
function canonicalValueKey(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) {
    return JSON.stringify(["arr", value.map((v) => String(v))]);
  }
  return JSON.stringify(["val", String(value)]);
}

/**
 * Canonical, round-trip-stable fingerprint of a condition set. Used for
 * grandfathering: a stored `value: 300` round-trips through the admin UI as
 * `"300"` (everything gets coerced through `String()` on the way back), so
 * the signature normalizes scalars via `String()` to keep those two forms
 * identical - otherwise every untouched legacy rule would look "changed" the
 * moment it round-trips through a save.
 *
 * Never throws.
 */
export function conditionSetSignature(
  conditions: readonly Condition[],
  logic: string,
): string {
  try {
    const normalizedLogic =
      typeof logic === "string" ? logic.toUpperCase() : String(logic);
    const list = Array.isArray(conditions) ? conditions : [];
    const parts = list.map((condition) => {
      const fieldId =
        typeof condition?.fieldId === "string" ? condition.fieldId : "";
      const operator =
        typeof condition?.operator === "string" ? condition.operator : "";
      return [fieldId, operator, canonicalValueKey(condition?.value)];
    });
    return JSON.stringify([normalizedLogic, parts]);
  } catch {
    return "";
  }
}
