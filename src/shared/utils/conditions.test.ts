import { describe, expect, it } from "vitest";
import { evaluateSingleCondition } from "./conditions.js";

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
