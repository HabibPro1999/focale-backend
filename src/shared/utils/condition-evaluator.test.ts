import { describe, it, expect } from "vitest";
import {
  evaluateSingleCondition,
  evaluateConditions,
  isEqual,
  containsValue,
  isEmpty,
  isGreaterThan,
  isLessThan,
  type EvaluableCondition,
} from "./condition-evaluator.js";

describe("Condition Evaluator", () => {
  describe("isEqual", () => {
    it("should match exact string values (case-insensitive)", () => {
      expect(isEqual("doctor", "doctor")).toBe(true);
      expect(isEqual("Doctor", "doctor")).toBe(true);
      expect(isEqual("DOCTOR", "doctor")).toBe(true);
      expect(isEqual("nurse", "doctor")).toBe(false);
    });

    it("should match array values (checkbox selections)", () => {
      expect(isEqual(["urgent", "important"], "urgent")).toBe(true);
      expect(isEqual(["Urgent"], "urgent")).toBe(true);
      expect(isEqual(["normal"], "urgent")).toBe(false);
    });

    it("should handle null/undefined values", () => {
      expect(isEqual(null, "")).toBe(true);
      expect(isEqual(undefined, "")).toBe(true);
      expect(isEqual(null, "null")).toBe(true);
      expect(isEqual(undefined, "undefined")).toBe(true);
      expect(isEqual(null, "something")).toBe(false);
    });

    it("should match boolean values", () => {
      expect(isEqual(true, "true")).toBe(true);
      expect(isEqual(false, "false")).toBe(true);
      expect(isEqual(true, "false")).toBe(false);
      expect(isEqual(false, "true")).toBe(false);
    });

    it("should match numeric values", () => {
      expect(isEqual(30, "30")).toBe(true);
      expect(isEqual(25, "30")).toBe(false);
    });
  });

  describe("containsValue", () => {
    it("should match substring in string (case-insensitive)", () => {
      expect(containsValue("cardiology", "cardio")).toBe(true);
      expect(containsValue("Cardiology", "cardio")).toBe(true);
      expect(containsValue("neurology", "cardio")).toBe(false);
    });

    it("should match substring in array values", () => {
      expect(containsValue(["urgent", "important"], "urg")).toBe(true);
      expect(containsValue(["normal"], "urg")).toBe(false);
    });

    it("should return false for null/undefined", () => {
      expect(containsValue(null, "cardio")).toBe(false);
      expect(containsValue(undefined, "cardio")).toBe(false);
    });
  });

  describe("isEmpty", () => {
    it("should detect empty strings", () => {
      expect(isEmpty("")).toBe(true);
      expect(isEmpty("   ")).toBe(true);
      expect(isEmpty("some text")).toBe(false);
    });

    it("should detect empty arrays", () => {
      expect(isEmpty([])).toBe(true);
      expect(isEmpty(["item"])).toBe(false);
    });

    it("should treat null/undefined as empty", () => {
      expect(isEmpty(null)).toBe(true);
      expect(isEmpty(undefined)).toBe(true);
    });
  });

  describe("isGreaterThan", () => {
    it("should compare numeric values", () => {
      expect(isGreaterThan(30, "25")).toBe(true);
      expect(isGreaterThan(25, "25")).toBe(false);
      expect(isGreaterThan(20, "25")).toBe(false);
    });

    it("should fall back to string comparison for non-numeric", () => {
      expect(isGreaterThan("2025-06-01", "2025-01-01")).toBe(true);
      expect(isGreaterThan("2024-12-01", "2025-01-01")).toBe(false);
    });

    it("should return false for invalid comparisons", () => {
      expect(isGreaterThan(null, "25")).toBe(false);
      expect(isGreaterThan(undefined, "25")).toBe(false);
    });
  });

  describe("isLessThan", () => {
    it("should compare numeric values", () => {
      expect(isLessThan(25, "30")).toBe(true);
      expect(isLessThan(30, "30")).toBe(false);
      expect(isLessThan(35, "30")).toBe(false);
    });

    it("should fall back to string comparison for non-numeric", () => {
      expect(isLessThan("2025-06-01", "2025-12-31")).toBe(true);
      expect(isLessThan("2026-01-01", "2025-12-31")).toBe(false);
    });

    it("should return false for invalid comparisons", () => {
      expect(isLessThan(null, "30")).toBe(false);
      expect(isLessThan(undefined, "30")).toBe(false);
    });
  });

  describe("evaluateSingleCondition", () => {
    const formData = {
      profession: "doctor",
      specialty: "cardiology",
      age: 30,
      tags: ["urgent", "important"],
      notes: "",
    };

    describe("equals operator", () => {
      it("should evaluate equals condition", () => {
        const condition: EvaluableCondition = {
          fieldId: "profession",
          operator: "equals",
          value: "doctor",
        };
        expect(evaluateSingleCondition(condition, formData)).toBe(true);
      });

      it("should be case-insensitive", () => {
        const condition: EvaluableCondition = {
          fieldId: "profession",
          operator: "equals",
          value: "DOCTOR",
        };
        expect(evaluateSingleCondition(condition, formData)).toBe(true);
      });
    });

    describe("not_equals operator", () => {
      it("should evaluate not_equals condition", () => {
        const condition: EvaluableCondition = {
          fieldId: "profession",
          operator: "not_equals",
          value: "nurse",
        };
        expect(evaluateSingleCondition(condition, formData)).toBe(true);
      });
    });

    describe("contains operator", () => {
      it("should evaluate contains condition", () => {
        const condition: EvaluableCondition = {
          fieldId: "specialty",
          operator: "contains",
          value: "cardio",
        };
        expect(evaluateSingleCondition(condition, formData)).toBe(true);
      });
    });

    describe("not_contains operator", () => {
      it("should evaluate not_contains condition", () => {
        const condition: EvaluableCondition = {
          fieldId: "specialty",
          operator: "not_contains",
          value: "neuro",
        };
        expect(evaluateSingleCondition(condition, formData)).toBe(true);
      });
    });

    describe("greater_than operator", () => {
      it("should evaluate greater_than condition", () => {
        const condition: EvaluableCondition = {
          fieldId: "age",
          operator: "greater_than",
          value: 25,
        };
        expect(evaluateSingleCondition(condition, formData)).toBe(true);
      });
    });

    describe("less_than operator", () => {
      it("should evaluate less_than condition", () => {
        const condition: EvaluableCondition = {
          fieldId: "age",
          operator: "less_than",
          value: 35,
        };
        expect(evaluateSingleCondition(condition, formData)).toBe(true);
      });
    });

    describe("is_empty operator", () => {
      it("should evaluate is_empty condition", () => {
        const condition: EvaluableCondition = {
          fieldId: "notes",
          operator: "is_empty",
          value: "",
        };
        expect(evaluateSingleCondition(condition, formData)).toBe(true);
      });
    });

    describe("is_not_empty operator", () => {
      it("should evaluate is_not_empty condition", () => {
        const condition: EvaluableCondition = {
          fieldId: "specialty",
          operator: "is_not_empty",
          value: "",
        };
        expect(evaluateSingleCondition(condition, formData)).toBe(true);
      });
    });

    describe("unknown operator handling", () => {
      it("should return false for unknown operator (default)", () => {
        const condition: EvaluableCondition = {
          fieldId: "profession",
          operator: "unknown_operator",
          value: "doctor",
        };
        expect(evaluateSingleCondition(condition, formData)).toBe(false);
      });

      it("should return false when unknownOperatorDefault is false", () => {
        const condition: EvaluableCondition = {
          fieldId: "profession",
          operator: "unknown_operator",
          value: "doctor",
        };
        expect(
          evaluateSingleCondition(condition, formData, {
            unknownOperatorDefault: false,
          }),
        ).toBe(false);
      });

      it("should return true when unknownOperatorDefault is true", () => {
        const condition: EvaluableCondition = {
          fieldId: "profession",
          operator: "unknown_operator",
          value: "doctor",
        };
        expect(
          evaluateSingleCondition(condition, formData, {
            unknownOperatorDefault: true,
          }),
        ).toBe(true);
      });
    });
  });

  describe("evaluateConditions", () => {
    const formData = {
      profession: "doctor",
      age: 30,
    };

    describe("AND logic", () => {
      it("should require all conditions to be met", () => {
        const conditions: EvaluableCondition[] = [
          { fieldId: "profession", operator: "equals", value: "doctor" },
          { fieldId: "age", operator: "greater_than", value: 25 },
        ];

        // Both conditions met
        expect(evaluateConditions(conditions, "and", formData)).toBe(true);

        // Only first condition met
        expect(
          evaluateConditions(conditions, "and", {
            profession: "doctor",
            age: 20,
          }),
        ).toBe(false);

        // Only second condition met
        expect(
          evaluateConditions(conditions, "and", {
            profession: "nurse",
            age: 30,
          }),
        ).toBe(false);

        // Neither condition met
        expect(
          evaluateConditions(conditions, "and", {
            profession: "nurse",
            age: 20,
          }),
        ).toBe(false);
      });

      it("should handle lowercase 'and'", () => {
        const conditions: EvaluableCondition[] = [
          { fieldId: "profession", operator: "equals", value: "doctor" },
          { fieldId: "age", operator: "greater_than", value: 25 },
        ];
        expect(evaluateConditions(conditions, "and", formData)).toBe(true);
      });
    });

    describe("OR logic", () => {
      it("should require at least one condition to be met", () => {
        const conditions: EvaluableCondition[] = [
          { fieldId: "profession", operator: "equals", value: "doctor" },
          { fieldId: "profession", operator: "equals", value: "nurse" },
        ];

        // First condition met
        expect(
          evaluateConditions(conditions, "or", { profession: "doctor" }),
        ).toBe(true);

        // Second condition met
        expect(
          evaluateConditions(conditions, "or", { profession: "nurse" }),
        ).toBe(true);

        // Neither condition met
        expect(
          evaluateConditions(conditions, "or", { profession: "pharmacist" }),
        ).toBe(false);
      });

      it("should handle lowercase 'or'", () => {
        const conditions: EvaluableCondition[] = [
          { fieldId: "profession", operator: "equals", value: "doctor" },
          { fieldId: "profession", operator: "equals", value: "nurse" },
        ];
        expect(
          evaluateConditions(conditions, "or", { profession: "doctor" }),
        ).toBe(true);
      });
    });

    describe("options propagation", () => {
      it("should pass unknownOperatorDefault to all conditions", () => {
        const conditions: EvaluableCondition[] = [
          {
            fieldId: "profession",
            operator: "unknown_operator",
            value: "test",
          },
        ];

        // Default (false)
        expect(evaluateConditions(conditions, "and", formData)).toBe(false);

        // Explicit false
        expect(
          evaluateConditions(conditions, "and", formData, {
            unknownOperatorDefault: false,
          }),
        ).toBe(false);

        // Explicit true
        expect(
          evaluateConditions(conditions, "and", formData, {
            unknownOperatorDefault: true,
          }),
        ).toBe(true);
      });
    });
  });
});
