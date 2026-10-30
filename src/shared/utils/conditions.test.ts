import { describe, expect, it } from "vitest";
import { evaluateConditions, evaluateSingleCondition } from "./conditions.js";

describe("evaluateSingleCondition", () => {
  it("returns true for not_contains when value is non-string", () => {
    const result = evaluateSingleCondition(
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
    const result = evaluateSingleCondition(
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
    const result = evaluateSingleCondition(
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
      evaluateSingleCondition(
        { fieldId: "age", operator: "greater_than", value: 18 },
        { age: "25" },
      ),
    ).toBe(true);

    expect(
      evaluateSingleCondition(
        { fieldId: "age", operator: "less_than", value: "18" },
        { age: "25" },
      ),
    ).toBe(false);
  });

  it("does not treat zero or false as empty", () => {
    expect(
      evaluateSingleCondition(
        { fieldId: "count", operator: "is_not_empty" },
        { count: 0 },
      ),
    ).toBe(true);

    expect(
      evaluateSingleCondition(
        { fieldId: "accepted", operator: "is_not_empty" },
        { accepted: false },
      ),
    ).toBe(true);

    expect(
      evaluateSingleCondition(
        { fieldId: "items", operator: "is_empty" },
        { items: [] },
      ),
    ).toBe(true);
  });
});

describe("in operator", () => {
  it("matches a scalar field value present in the list", () => {
    expect(
      evaluateSingleCondition(
        { fieldId: "category", operator: "in", value: ["gold", "silver"] },
        { category: "gold" },
      ),
    ).toBe(true);
  });

  it("does not match a scalar field value absent from the list", () => {
    expect(
      evaluateSingleCondition(
        { fieldId: "category", operator: "in", value: ["gold", "silver"] },
        { category: "bronze" },
      ),
    ).toBe(false);
  });

  it("matches an array field value with at least one overlap (checkbox support)", () => {
    expect(
      evaluateSingleCondition(
        { fieldId: "interests", operator: "in", value: ["a", "b"] },
        { interests: ["c", "b"] },
      ),
    ).toBe(true);
  });

  it("does not match an array field value with no overlap", () => {
    expect(
      evaluateSingleCondition(
        { fieldId: "interests", operator: "in", value: ["a", "b"] },
        { interests: ["c", "d"] },
      ),
    ).toBe(false);
  });

  it("does not match an empty array field value", () => {
    expect(
      evaluateSingleCondition(
        { fieldId: "interests", operator: "in", value: ["a", "b"] },
        { interests: [] },
      ),
    ).toBe(false);
  });

  it("does not match a missing field", () => {
    expect(
      evaluateSingleCondition(
        { fieldId: "category", operator: "in", value: ["gold"] },
        {},
      ),
    ).toBe(false);
  });

  it("does not match a null field", () => {
    expect(
      evaluateSingleCondition(
        { fieldId: "category", operator: "in", value: ["gold"] },
        { category: null },
      ),
    ).toBe(false);
  });

  it("never matches an empty list", () => {
    expect(
      evaluateSingleCondition(
        { fieldId: "category", operator: "in", value: [] },
        { category: "gold" },
      ),
    ).toBe(false);
  });

  it("coerces numeric and boolean values identically to equals", () => {
    expect(
      evaluateSingleCondition(
        { fieldId: "age", operator: "in", value: ["18", "25"] },
        { age: 25 },
      ),
    ).toBe(true);

    expect(
      evaluateSingleCondition(
        { fieldId: "accepted", operator: "in", value: ["true"] },
        { accepted: true },
      ),
    ).toBe(true);
  });

  it("degrades to equals when the condition value is a scalar, not a list", () => {
    expect(
      evaluateSingleCondition(
        {
          fieldId: "category",
          operator: "in",
          value: "gold" as unknown as string[],
        },
        { category: "gold" },
      ),
    ).toBe(true);

    expect(
      evaluateSingleCondition(
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
      evaluateSingleCondition({ fieldId: "category", operator: "in" }, {}),
    ).toBe(false);
  });

  it("fails closed for the unknown not_in operator", () => {
    expect(
      evaluateSingleCondition(
        { fieldId: "category", operator: "not_in", value: ["gold"] },
        { category: "silver" },
      ),
    ).toBe(false);

    expect(
      evaluateSingleCondition(
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
    expect(evaluateConditions(threeEquals, "AND", formData)).toBe(false);

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
    expect(evaluateConditions(equivalentIn, "AND", formData)).toBe(true);
  });
});

describe("evaluateConditions", () => {
  it("fails closed for unknown logic", () => {
    const result = evaluateConditions(
      [{ fieldId: "role", operator: "equals", value: "admin" }],
      "XOR",
      { role: "admin" },
    );

    expect(result).toBe(false);
  });

  it("keeps vacuous truth only for AND", () => {
    expect(evaluateConditions([], "AND", {})).toBe(true);
    expect(evaluateConditions([], "OR", {})).toBe(false);
    expect(evaluateConditions([], "INVALID", {})).toBe(false);
  });

  it("supports boolean equality without collapsing missing values to null", () => {
    expect(
      evaluateConditions(
        [{ fieldId: "active", operator: "equals", value: true }],
        "AND",
        { active: true },
      ),
    ).toBe(true);

    expect(
      evaluateConditions(
        [{ fieldId: "missing", operator: "equals", value: null }],
        "AND",
        {},
      ),
    ).toBe(false);

    expect(
      evaluateConditions(
        [{ fieldId: "blank", operator: "equals", value: "" }],
        "AND",
        { blank: "" },
      ),
    ).toBe(true);
  });
});
