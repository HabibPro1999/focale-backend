import { describe, expect, it } from "vitest";
import { ConditionSchema } from "./condition.schema";

describe("ConditionSchema", () => {
  it("accepts a basic equals condition", () => {
    expect(
      ConditionSchema.safeParse({
        fieldId: "role",
        operator: "equals",
        value: "admin",
      }).success,
    ).toBe(true);
  });

  it("requires a numeric value for greater_than / less_than", () => {
    expect(
      ConditionSchema.safeParse({
        fieldId: "age",
        operator: "greater_than",
        value: "not-a-number",
      }).success,
    ).toBe(false);

    expect(
      ConditionSchema.safeParse({
        fieldId: "age",
        operator: "greater_than",
        value: "18",
      }).success,
    ).toBe(true);

    expect(
      ConditionSchema.safeParse({
        fieldId: "age",
        operator: "less_than",
        value: 65,
      }).success,
    ).toBe(true);
  });

  it("rejects unknown operators and extra keys", () => {
    expect(
      ConditionSchema.safeParse({ fieldId: "x", operator: "matches" }).success,
    ).toBe(false);
    expect(
      ConditionSchema.safeParse({
        fieldId: "x",
        operator: "equals",
        extra: 1,
      }).success,
    ).toBe(false);
  });
});
