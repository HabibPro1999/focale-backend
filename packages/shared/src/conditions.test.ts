import { describe, expect, it } from "vitest";
import { evaluateConditions, evaluateSingleCondition } from "./conditions";

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
