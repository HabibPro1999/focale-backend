import { describe, expect, it } from "vitest";
import { ConditionSchema } from "./condition.schema.js";

describe("ConditionSchema", () => {
  describe("in operator", () => {
    it("parses a non-empty array value", () => {
      const result = ConditionSchema.safeParse({
        fieldId: "category",
        operator: "in",
        value: ["gold", "silver"],
      });

      expect(result.success).toBe(true);
    });

    it("rejects an empty array value", () => {
      const result = ConditionSchema.safeParse({
        fieldId: "category",
        operator: "in",
        value: [],
      });

      expect(result.success).toBe(false);
    });

    it("rejects a scalar value", () => {
      const result = ConditionSchema.safeParse({
        fieldId: "category",
        operator: "in",
        value: "gold",
      });

      expect(result.success).toBe(false);
    });

    it("rejects an omitted value", () => {
      const result = ConditionSchema.safeParse({
        fieldId: "category",
        operator: "in",
      });

      expect(result.success).toBe(false);
    });

    it("rejects the not_in operator at the enum level", () => {
      const result = ConditionSchema.safeParse({
        fieldId: "category",
        operator: "not_in",
        value: ["gold"],
      });

      expect(result.success).toBe(false);
    });
  });

  describe("scalar operators reject list values", () => {
    it("rejects an array value on equals", () => {
      const result = ConditionSchema.safeParse({
        fieldId: "category",
        operator: "equals",
        value: ["gold", "silver"],
      });

      expect(result.success).toBe(false);
    });

    it("rejects an array value on not_equals", () => {
      const result = ConditionSchema.safeParse({
        fieldId: "category",
        operator: "not_equals",
        value: ["gold"],
      });

      expect(result.success).toBe(false);
    });

    it("still accepts a scalar value on equals", () => {
      const result = ConditionSchema.safeParse({
        fieldId: "category",
        operator: "equals",
        value: "gold",
      });

      expect(result.success).toBe(true);
    });
  });

  describe("numeric refine (pre-existing, locked in)", () => {
    it("accepts a numeric value for greater_than", () => {
      const result = ConditionSchema.safeParse({
        fieldId: "age",
        operator: "greater_than",
        value: 18,
      });

      expect(result.success).toBe(true);
    });

    it("accepts a numeric string for less_than", () => {
      const result = ConditionSchema.safeParse({
        fieldId: "age",
        operator: "less_than",
        value: "18",
      });

      expect(result.success).toBe(true);
    });

    it("rejects a non-numeric value for greater_than", () => {
      const result = ConditionSchema.safeParse({
        fieldId: "age",
        operator: "greater_than",
        value: "not-a-number",
      });

      expect(result.success).toBe(false);
    });

    it("rejects an omitted value for less_than", () => {
      const result = ConditionSchema.safeParse({
        fieldId: "age",
        operator: "less_than",
      });

      expect(result.success).toBe(false);
    });
  });

  describe("valueless operators", () => {
    it("accepts is_empty with no value", () => {
      const result = ConditionSchema.safeParse({
        fieldId: "category",
        operator: "is_empty",
      });

      expect(result.success).toBe(true);
    });

    it("accepts is_not_empty with no value", () => {
      const result = ConditionSchema.safeParse({
        fieldId: "category",
        operator: "is_not_empty",
      });

      expect(result.success).toBe(true);
    });
  });
});
