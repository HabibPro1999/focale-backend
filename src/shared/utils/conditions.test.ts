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

  it("supports boolean and null equality values", () => {
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
    ).toBe(true);
  });
});
