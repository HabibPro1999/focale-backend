import { z } from "zod";

export const ConditionSchema = z
  .strictObject({
    fieldId: z.string().min(1),
    operator: z.enum([
      "equals",
      "not_equals",
      "contains",
      "not_contains",
      "greater_than",
      "less_than",
      "is_empty",
      "is_not_empty",
      "in",
    ]),
    value: z
      .union([
        z.string(),
        z.number(),
        z.boolean(),
        z.null(),
        z.array(z.string()),
      ])
      .optional(),
  })
  .superRefine((condition, ctx) => {
    const value = condition.value;

    // `in` is the only list-valued operator. An empty list can never match —
    // exactly the class of silently-dead rule this operator exists to fix.
    if (condition.operator === "in") {
      if (!Array.isArray(value) || value.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["value"],
          message: "in conditions require a non-empty array of values",
        });
      }
      return;
    }

    // Every other operator is scalar. Without this an array would reach the
    // evaluator and be silently joined ("a,b") by String() coercion.
    if (Array.isArray(value)) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: `${condition.operator} conditions do not accept a list value`,
      });
      return;
    }

    if (
      condition.operator !== "greater_than" &&
      condition.operator !== "less_than"
    ) {
      return;
    }

    const numericValue =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim() !== ""
          ? Number(value)
          : Number.NaN;

    if (!Number.isFinite(numericValue)) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: `${condition.operator} conditions require a numeric value`,
      });
    }
  });

export type Condition = z.infer<typeof ConditionSchema>;
