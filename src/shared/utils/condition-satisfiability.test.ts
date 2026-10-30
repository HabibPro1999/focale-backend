import { describe, expect, it } from "vitest";
import {
  findConditionConflicts,
  conditionSetSignature,
  type FindConditionConflictsOptions,
} from "./condition-satisfiability.js";
import { evaluateConditions, type Condition } from "./conditions.js";

// ============================================================================
// Keystone cross-check harness
//
// The guard makes static claims about `conditions.ts`'s runtime behaviour
// ("these conditions can never all be true together"). This harness keeps
// those claims honest against the REAL evaluator rather than trusting the
// guard's own reasoning about itself: for every must-flag fixture we
// brute-force a representative candidate `formData` space and assert the
// evaluator returns `false` for every single candidate; for every
// must-NOT-flag fixture we assert at least one candidate (a witness) makes
// it `true`. This is what would catch a future edit to `conditions.ts`
// silently invalidating one of the guard's rules.
// ============================================================================

function referencedMembers(
  conditions: readonly Condition[],
  fieldId: string,
): string[] {
  const members = new Set<string>();
  for (const c of conditions) {
    if (c.fieldId !== fieldId) continue;
    if (Array.isArray(c.value)) {
      c.value.forEach((v) => members.add(String(v)));
    } else if (c.value !== null && c.value !== undefined) {
      members.add(String(c.value));
    }
  }
  return [...members];
}

function candidatesForField(
  conditions: readonly Condition[],
  fieldId: string,
): unknown[] {
  const members = referencedMembers(conditions, fieldId);
  const candidates: unknown[] = [
    undefined, // field entirely absent from formData
    null,
    "",
    0,
    "__unmatched_probe__",
    [],
    ...members,
  ];
  // Singleton arrays — checkbox actual with exactly one option selected.
  members.forEach((m) => candidates.push([m]));
  // Pairs — checkbox actual with two options selected (needed to find
  // overlap/no-overlap witnesses across two different `in` lists).
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      candidates.push([members[i], members[j]]);
    }
  }
  return candidates;
}

function bruteForceFormData(
  conditions: readonly Condition[],
): Record<string, unknown>[] {
  const fieldIds = [...new Set(conditions.map((c) => c.fieldId))];
  let combos: Record<string, unknown>[] = [{}];
  for (const fieldId of fieldIds) {
    const candidates = candidatesForField(conditions, fieldId);
    const next: Record<string, unknown>[] = [];
    for (const combo of combos) {
      for (const candidate of candidates) {
        if (candidate === undefined) {
          next.push({ ...combo });
        } else {
          next.push({ ...combo, [fieldId]: candidate });
        }
      }
    }
    combos = next;
  }
  return combos;
}

function assertNeverSatisfiable(
  conditions: Condition[],
  logic: string,
): void {
  const combos = bruteForceFormData(conditions);
  expect(combos.length).toBeGreaterThan(0);
  for (const formData of combos) {
    expect(evaluateConditions(conditions, logic, formData)).toBe(false);
  }
}

function assertWitnessExists(conditions: Condition[], logic: string): void {
  const combos = bruteForceFormData(conditions);
  const witnessExists = combos.some((formData) =>
    evaluateConditions(conditions, logic, formData),
  );
  expect(witnessExists).toBe(true);
}

// The exact prod payload from the TSHG incident: three `equals` stacked on
// one dropdown under AND can never all hold.
const tshgProdPayload: Condition[] = [
  { fieldId: "dropdown_CAT", operator: "equals", value: "opt_phd" },
  { fieldId: "dropdown_CAT", operator: "equals", value: "opt_resident" },
  { fieldId: "dropdown_CAT", operator: "equals", value: "opt_postgrad" },
  {
    fieldId: "radio_PAY",
    operator: "not_equals",
    value: "opt_purchase_order",
  },
];

interface Fixture {
  name: string;
  conditions: Condition[];
  logic: string;
  options?: FindConditionConflictsOptions;
}

const mustFlagFixtures: Fixture[] = [
  {
    name: "the exact prod payload (TSHG rule) under AND",
    conditions: tshgProdPayload,
    logic: "AND",
  },
  {
    name: "rule 1: equals A + equals B, different keys",
    conditions: [
      { fieldId: "f", operator: "equals", value: "gold" },
      { fieldId: "f", operator: "equals", value: "silver" },
    ],
    logic: "AND",
  },
  {
    name: "rule 2: equals A + not_equals A, same key",
    conditions: [
      { fieldId: "f", operator: "equals", value: "gold" },
      { fieldId: "f", operator: "not_equals", value: "gold" },
    ],
    logic: "AND",
  },
  {
    name: "rule 3: is_empty + is_not_empty",
    conditions: [
      { fieldId: "f", operator: "is_empty" },
      { fieldId: "f", operator: "is_not_empty" },
    ],
    logic: "AND",
  },
  {
    name: "rule 4: is_empty + equals E, E not an empty literal",
    conditions: [
      { fieldId: "f", operator: "is_empty" },
      { fieldId: "f", operator: "equals", value: "gold" },
    ],
    logic: "AND",
  },
  {
    name: "rule 5: greater_than a + less_than b, the >= boundary (a === b)",
    conditions: [
      { fieldId: "age", operator: "greater_than", value: 10 },
      { fieldId: "age", operator: "less_than", value: 10 },
    ],
    logic: "AND",
  },
  {
    name: "rule 5: greater_than a + less_than b, a > b",
    conditions: [
      { fieldId: "age", operator: "greater_than", value: 10 },
      { fieldId: "age", operator: "less_than", value: 5 },
    ],
    logic: "AND",
  },
  {
    name: "rule 6: contains S1 + not_contains S2, S1 contains S2",
    conditions: [
      { fieldId: "bio", operator: "contains", value: "hello world" },
      { fieldId: "bio", operator: "not_contains", value: "hello" },
    ],
    logic: "AND",
  },
  {
    name: "rule 7: in [] alone can never match",
    conditions: [{ fieldId: "f", operator: "in", value: [] }],
    logic: "AND",
  },
  {
    name: "rule 8: equals X + in L, X not in L, X is comma-free",
    conditions: [
      { fieldId: "f", operator: "equals", value: "gold" },
      { fieldId: "f", operator: "in", value: ["silver", "bronze"] },
    ],
    logic: "AND",
  },
];

const mustNotFlagFixtures: Fixture[] = [
  {
    name: 'equals 300 vs equals "300" (same string key)',
    conditions: [
      { fieldId: "f", operator: "equals", value: 300 },
      { fieldId: "f", operator: "equals", value: "300" },
    ],
    logic: "AND",
  },
  {
    name: 'is_empty + equals "" (satisfiable — witness ""))',
    conditions: [
      { fieldId: "f", operator: "is_empty" },
      { fieldId: "f", operator: "equals", value: "" },
    ],
    logic: "AND",
  },
  {
    name: 'is_not_empty + equals "" (satisfiable — witness [""])',
    conditions: [
      { fieldId: "f", operator: "is_not_empty" },
      { fieldId: "f", operator: "equals", value: "" },
    ],
    logic: "AND",
  },
  {
    name: "different fieldIds — no cross-field inference, ever",
    conditions: [
      { fieldId: "f1", operator: "equals", value: "gold" },
      { fieldId: "f2", operator: "not_equals", value: "gold" },
    ],
    logic: "AND",
  },
  {
    name: "the exact prod payload (TSHG rule) under OR",
    conditions: tshgProdPayload,
    logic: "OR",
  },
  {
    name: "the comma escape hatch: equals with a comma vs in",
    conditions: [
      { fieldId: "f", operator: "equals", value: "a,b" },
      { fieldId: "f", operator: "in", value: ["a", "b"] },
    ],
    logic: "AND",
  },
  {
    name: "tier 3: in vs in, disjoint, but field not declared single-valued (checkbox default)",
    conditions: [
      { fieldId: "tags", operator: "in", value: ["a", "b"] },
      { fieldId: "tags", operator: "in", value: ["c", "d"] },
    ],
    logic: "AND",
  },
];

describe("findConditionConflicts — keystone cross-check", () => {
  describe("must flag (brute-forced formData is always false)", () => {
    for (const fixture of mustFlagFixtures) {
      it(fixture.name, () => {
        const conflicts = findConditionConflicts(
          fixture.conditions,
          fixture.logic,
          fixture.options,
        );
        expect(conflicts.length).toBeGreaterThan(0);
        assertNeverSatisfiable(fixture.conditions, fixture.logic);
      });
    }
  });

  describe("must NOT flag (a witness formData exists)", () => {
    for (const fixture of mustNotFlagFixtures) {
      it(fixture.name, () => {
        const conflicts = findConditionConflicts(
          fixture.conditions,
          fixture.logic,
          fixture.options,
        );
        expect(conflicts).toEqual([]);
        assertWitnessExists(fixture.conditions, fixture.logic);
      });
    }
  });
});

describe("findConditionConflicts — conflict shape", () => {
  it("points indices/fieldId/values at the offending pair (TSHG prod payload)", () => {
    const conflicts = findConditionConflicts(tshgProdPayload, "AND");
    const equalsConflicts = conflicts.filter(
      (c) => c.reason === "equals_conflict",
    );
    expect(equalsConflicts.length).toBeGreaterThan(0);
    for (const conflict of equalsConflicts) {
      expect(conflict.fieldId).toBe("dropdown_CAT");
      expect(conflict.indices.length).toBe(2);
      expect(
        conflict.indices.every((i) => i >= 0 && i < tshgProdPayload.length),
      ).toBe(true);
      expect(conflict.values).toHaveLength(conflict.indices.length);
    }
  });

  it("reports rule 7 (`in []`) as a single-index conflict", () => {
    const conflicts = findConditionConflicts(
      [{ fieldId: "f", operator: "in", value: [] }],
      "AND",
    );
    expect(conflicts).toEqual([
      { reason: "empty_in_conflict", fieldId: "f", indices: [0], values: [[]] },
    ]);
  });

  it("does not flag `in` with a scalar value — the evaluator degrades it to `equals`", () => {
    // isInValue treats a non-array condition value as a one-element list, so
    // `in "a"` matches { f: "a" }. Flagging it here would contradict the
    // evaluator and reject a rule that works.
    const conditions: Condition[] = [
      { fieldId: "f", operator: "in", value: "a" },
    ];
    expect(findConditionConflicts(conditions, "AND")).toEqual([]);
    expect(evaluateConditions(conditions, "AND", { f: "a" })).toBe(true);
  });

  it("does not flag `in` with an omitted value (unsatisfiable, but not this rule's job)", () => {
    // isInValue returns false for a null/undefined condition value, so this
    // never matches — but the schema already rejects it at write time and the
    // guard stays silent rather than duplicating per-condition validation.
    expect(
      findConditionConflicts([{ fieldId: "f", operator: "in" }], "AND"),
    ).toEqual([]);
  });
});

describe("findConditionConflicts — Tier 3 (opt-in, admin only)", () => {
  const disjointIn: Condition[] = [
    { fieldId: "dropdown_CAT", operator: "in", value: ["a", "b"] },
    { fieldId: "dropdown_CAT", operator: "in", value: ["c", "d"] },
  ];

  it("is NOT flagged by default — the backend never passes singleValuedFieldIds", () => {
    expect(findConditionConflicts(disjointIn, "AND")).toEqual([]);
  });

  it("IS flagged when the field is declared single-valued", () => {
    const conflicts = findConditionConflicts(disjointIn, "AND", {
      singleValuedFieldIds: new Set(["dropdown_CAT"]),
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].reason).toBe("in_in_conflict");
  });

  it("is NOT flagged when the lists overlap, even if declared single-valued", () => {
    const overlapping: Condition[] = [
      { fieldId: "dropdown_CAT", operator: "in", value: ["a", "b"] },
      { fieldId: "dropdown_CAT", operator: "in", value: ["b", "c"] },
    ];
    expect(
      findConditionConflicts(overlapping, "AND", {
        singleValuedFieldIds: new Set(["dropdown_CAT"]),
      }),
    ).toEqual([]);
  });
});

describe("findConditionConflicts — never throws", () => {
  it("returns no conflict for unknown/future operators", () => {
    const conditions: Condition[] = [
      { fieldId: "f", operator: "starts_with", value: "a" },
      { fieldId: "f", operator: "ends_with", value: "b" },
    ];
    expect(findConditionConflicts(conditions, "AND")).toEqual([]);
  });

  it("never throws on malformed/legacy condition shapes", () => {
    const weird = [
      { fieldId: "f", operator: "equals" }, // omitted value
      { fieldId: "f", operator: "in", value: "not-an-array" },
      { operator: "equals", value: "x" }, // missing fieldId
      null,
      undefined,
      42,
      "garbage",
    ] as unknown as Condition[];

    expect(() => findConditionConflicts(weird, "AND")).not.toThrow();
  });

  it("never throws when conditions or logic are the wrong type", () => {
    expect(() =>
      findConditionConflicts(null as unknown as Condition[], "AND"),
    ).not.toThrow();
    expect(() =>
      findConditionConflicts(undefined as unknown as Condition[], "AND"),
    ).not.toThrow();
    expect(() =>
      findConditionConflicts([], 123 as unknown as string),
    ).not.toThrow();
  });

  it("returns [] for an empty conditions array", () => {
    expect(findConditionConflicts([], "AND")).toEqual([]);
  });
});

describe("findConditionConflicts — near-boundary satisfiable range (not a brute-force fixture)", () => {
  it("does not flag greater_than 5 + less_than 6 (a < b) — witness age=5.5", () => {
    const conditions: Condition[] = [
      { fieldId: "age", operator: "greater_than", value: 5 },
      { fieldId: "age", operator: "less_than", value: 6 },
    ];
    expect(findConditionConflicts(conditions, "AND")).toEqual([]);
    expect(evaluateConditions(conditions, "AND", { age: 5.5 })).toBe(true);
  });
});

describe("conditionSetSignature", () => {
  it("is stable across repeated calls with the same input", () => {
    const conditions: Condition[] = [
      { fieldId: "f", operator: "equals", value: "a" },
    ];
    expect(conditionSetSignature(conditions, "AND")).toBe(
      conditionSetSignature(conditions, "AND"),
    );
  });

  it("treats a numeric value and its string form as identical (RuleEditor round-trip)", () => {
    const numeric: Condition[] = [
      { fieldId: "f", operator: "equals", value: 300 },
    ];
    const stringified: Condition[] = [
      { fieldId: "f", operator: "equals", value: "300" },
    ];
    expect(conditionSetSignature(numeric, "AND")).toBe(
      conditionSetSignature(stringified, "AND"),
    );
  });

  it("changes when a condition value changes", () => {
    const a: Condition[] = [{ fieldId: "f", operator: "equals", value: "a" }];
    const b: Condition[] = [{ fieldId: "f", operator: "equals", value: "b" }];
    expect(conditionSetSignature(a, "AND")).not.toBe(
      conditionSetSignature(b, "AND"),
    );
  });

  it("changes when the logic changes", () => {
    const conditions: Condition[] = [
      { fieldId: "f", operator: "equals", value: "a" },
    ];
    expect(conditionSetSignature(conditions, "AND")).not.toBe(
      conditionSetSignature(conditions, "OR"),
    );
  });

  it('distinguishes the literal null from the string "null"', () => {
    const withNull: Condition[] = [
      { fieldId: "f", operator: "equals", value: null },
    ];
    const withStringNull: Condition[] = [
      { fieldId: "f", operator: "equals", value: "null" },
    ];
    expect(conditionSetSignature(withNull, "AND")).not.toBe(
      conditionSetSignature(withStringNull, "AND"),
    );
  });

  it("never throws on malformed input", () => {
    expect(() =>
      conditionSetSignature(
        [{ fieldId: 123, operator: null, value: undefined }] as unknown as Condition[],
        "AND",
      ),
    ).not.toThrow();
    expect(() =>
      conditionSetSignature(null as unknown as Condition[], "AND"),
    ).not.toThrow();
  });
});
