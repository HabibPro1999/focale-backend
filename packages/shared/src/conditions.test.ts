import { describe, expect, it } from "vitest";
import { evaluateRuleConditions, evaluateRuleCondition } from "./conditions";

describe("evaluateRuleCondition", () => {
  it("returns true for not_contains when value is non-string", () => {
    const result = evaluateRuleCondition(
      {
        fieldId: "age",
        operator: "not_contains",
        value: "42",
      },
      { age: 42 },
    );

    expect(result).toBe(true);
  });

  it("returns false for not_contains when string contains substring", () => {
    const result = evaluateRuleCondition(
      {
        fieldId: "name",
        operator: "not_contains",
        value: "Ali",
      },
      { name: "Alice" },
    );

    expect(result).toBe(false);
  });

  it("returns true for not_contains when value is undefined", () => {
    const result = evaluateRuleCondition(
      {
        fieldId: "company",
        operator: "not_contains",
        value: "Corp",
      },
      {},
    );

    expect(result).toBe(true);
  });

  it("compares numeric strings for greater_than and less_than", () => {
    expect(
      evaluateRuleCondition(
        { fieldId: "age", operator: "greater_than", value: 18 },
        { age: "25" },
      ),
    ).toBe(true);

    expect(
      evaluateRuleCondition(
        { fieldId: "age", operator: "less_than", value: "18" },
        { age: "25" },
      ),
    ).toBe(false);
  });

  it("does not treat zero or false as empty", () => {
    expect(
      evaluateRuleCondition(
        { fieldId: "count", operator: "is_not_empty" },
        { count: 0 },
      ),
    ).toBe(true);

    expect(
      evaluateRuleCondition(
        { fieldId: "accepted", operator: "is_not_empty" },
        { accepted: false },
      ),
    ).toBe(true);

    expect(
      evaluateRuleCondition(
        { fieldId: "items", operator: "is_empty" },
        { items: [] },
      ),
    ).toBe(true);
  });
});

describe("in operator", () => {
  it("matches a scalar field value present in the list", () => {
    expect(
      evaluateRuleCondition(
        { fieldId: "category", operator: "in", value: ["gold", "silver"] },
        { category: "gold" },
      ),
    ).toBe(true);
  });

  it("does not match a scalar field value absent from the list", () => {
    expect(
      evaluateRuleCondition(
        { fieldId: "category", operator: "in", value: ["gold", "silver"] },
        { category: "bronze" },
      ),
    ).toBe(false);
  });

  it("matches an array field value with at least one overlap (checkbox support)", () => {
    expect(
      evaluateRuleCondition(
        { fieldId: "interests", operator: "in", value: ["a", "b"] },
        { interests: ["c", "b"] },
      ),
    ).toBe(true);
  });

  it("does not match an array field value with no overlap", () => {
    expect(
      evaluateRuleCondition(
        { fieldId: "interests", operator: "in", value: ["a", "b"] },
        { interests: ["c", "d"] },
      ),
    ).toBe(false);
  });

  it("does not match an empty array field value", () => {
    expect(
      evaluateRuleCondition(
        { fieldId: "interests", operator: "in", value: ["a", "b"] },
        { interests: [] },
      ),
    ).toBe(false);
  });

  it("does not match a missing field", () => {
    expect(
      evaluateRuleCondition(
        { fieldId: "category", operator: "in", value: ["gold"] },
        {},
      ),
    ).toBe(false);
  });

  it("does not match a null field", () => {
    expect(
      evaluateRuleCondition(
        { fieldId: "category", operator: "in", value: ["gold"] },
        { category: null },
      ),
    ).toBe(false);
  });

  it("never matches an empty list", () => {
    expect(
      evaluateRuleCondition(
        { fieldId: "category", operator: "in", value: [] },
        { category: "gold" },
      ),
    ).toBe(false);
  });

  it("coerces numeric and boolean values identically to equals", () => {
    expect(
      evaluateRuleCondition(
        { fieldId: "age", operator: "in", value: ["18", "25"] },
        { age: 25 },
      ),
    ).toBe(true);

    expect(
      evaluateRuleCondition(
        { fieldId: "accepted", operator: "in", value: ["true"] },
        { accepted: true },
      ),
    ).toBe(true);
  });

  it("degrades to equals when the condition value is a scalar, not a list", () => {
    expect(
      evaluateRuleCondition(
        {
          fieldId: "category",
          operator: "in",
          value: "gold" as unknown as string[],
        },
        { category: "gold" },
      ),
    ).toBe(true);

    expect(
      evaluateRuleCondition(
        {
          fieldId: "category",
          operator: "in",
          value: "gold" as unknown as string[],
        },
        { category: "silver" },
      ),
    ).toBe(false);
  });

  it("does not match when the condition value is omitted", () => {
    // Guards the isEqualValue(undefined, undefined) === true trap: without
    // the explicit null/undefined guard in isInValue, an omitted value would
    // degrade to candidates = [undefined] and match a missing field.
    expect(
      evaluateRuleCondition({ fieldId: "category", operator: "in" }, {}),
    ).toBe(false);
  });

  it("fails closed for the unknown not_in operator", () => {
    expect(
      evaluateRuleCondition(
        { fieldId: "category", operator: "not_in", value: ["gold"] },
        { category: "silver" },
      ),
    ).toBe(false);

    expect(
      evaluateRuleCondition(
        { fieldId: "category", operator: "not_in", value: ["gold"] },
        { category: "gold" },
      ),
    ).toBe(false);
  });

  it("keystone: encodes the client's actual bug — three equals on one field under AND is dead, the equivalent in is not", () => {
    const formData = { dropdown_CAT: "opt_phd", radio_PAY: "opt_cash" };

    const threeEquals = [
      { fieldId: "dropdown_CAT", operator: "equals", value: "opt_phd" },
      { fieldId: "dropdown_CAT", operator: "equals", value: "opt_resident" },
      { fieldId: "dropdown_CAT", operator: "equals", value: "opt_postgrad" },
      {
        fieldId: "radio_PAY",
        operator: "not_equals",
        value: "opt_purchase_order",
      },
    ];
    expect(evaluateRuleConditions(threeEquals, "AND", formData)).toBe(false);

    const equivalentIn = [
      {
        fieldId: "dropdown_CAT",
        operator: "in",
        value: ["opt_phd", "opt_resident", "opt_postgrad"],
      },
      {
        fieldId: "radio_PAY",
        operator: "not_equals",
        value: "opt_purchase_order",
      },
    ];
    expect(evaluateRuleConditions(equivalentIn, "AND", formData)).toBe(true);
  });
});

describe("evaluateRuleConditions", () => {
  it("fails closed for unknown logic", () => {
    const result = evaluateRuleConditions(
      [{ fieldId: "role", operator: "equals", value: "admin" }],
      "XOR",
      { role: "admin" },
    );

    expect(result).toBe(false);
  });

  it("keeps vacuous truth only for AND", () => {
    expect(evaluateRuleConditions([], "AND", {})).toBe(true);
    expect(evaluateRuleConditions([], "OR", {})).toBe(false);
    expect(evaluateRuleConditions([], "INVALID", {})).toBe(false);
  });

  it("supports boolean equality without collapsing missing values to null", () => {
    expect(
      evaluateRuleConditions(
        [{ fieldId: "active", operator: "equals", value: true }],
        "AND",
        { active: true },
      ),
    ).toBe(true);

    expect(
      evaluateRuleConditions(
        [{ fieldId: "missing", operator: "equals", value: null }],
        "AND",
        {},
      ),
    ).toBe(false);

    expect(
      evaluateRuleConditions(
        [{ fieldId: "blank", operator: "equals", value: "" }],
        "AND",
        { blank: "" },
      ),
    ).toBe(true);
  });
});

// Copied from the form app's own test of its pricing copy of this evaluator
// (form/src/lib/pricing-conditions.test.ts, develop ba6c271), with the names
// mapped: the form's pricing preview must keep charging what the server charges.
describe("rule conditions — parity with the form app's pricing evaluator", () => {
  const evaluateSingleCondition = evaluateRuleCondition;
  const evaluateConditions = evaluateRuleConditions;

  it("compares case-sensitively while allowing numeric strings", () => {
    expect(evaluateSingleCondition({ fieldId: "x", operator: "equals", value: "Member" }, { x: "member" })).toBe(false);
    expect(evaluateSingleCondition({ fieldId: "x", operator: "equals", value: 42 }, { x: "42" })).toBe(true);
  });

  it("uses in for checkbox intersections without changing equals", () => {
    const data = { x: ["member", "speaker"] };
    expect(evaluateSingleCondition({ fieldId: "x", operator: "in", value: ["speaker", "student"] }, data)).toBe(true);
    expect(evaluateSingleCondition({ fieldId: "x", operator: "equals", value: "speaker" }, data)).toBe(false);
    expect(evaluateSingleCondition({ fieldId: "x", operator: "in", value: [] }, data)).toBe(false);
    expect(evaluateSingleCondition({ fieldId: "x", operator: "in" }, {})).toBe(false);
  });

  it.each(["", " ", null, false, "2026-09-07", Infinity])("rejects invalid numeric input %s", (x) => {
    expect(evaluateSingleCondition({ fieldId: "x", operator: "less_than", value: 10 }, { x })).toBe(false);
  });

  it("honors empty AND/OR and rejects unknown operators and logic", () => {
    expect(evaluateConditions([], "AND", {})).toBe(true);
    expect(evaluateConditions([], "OR", {})).toBe(false);
    expect(evaluateConditions([], "unknown", {})).toBe(false);
    expect(evaluateSingleCondition({ fieldId: "x", operator: "unknown" }, {})).toBe(false);
  });

  it("differs from field visibility on purpose: case-sensitive, and logic case-insensitive", () => {
    expect(evaluateConditions([{ fieldId: "x", operator: "equals", value: "Other" }], "and", { x: "other" })).toBe(false);
    expect(
      evaluateConditions(
        [
          { fieldId: "a", operator: "equals", value: "1" },
          { fieldId: "b", operator: "equals", value: "2" },
        ],
        "AND",
        { a: "1", b: "x" },
      ),
    ).toBe(false);
  });
});
