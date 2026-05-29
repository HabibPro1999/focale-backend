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
    ]),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  })
  .superRefine((condition, ctx) => {
    if (
      condition.operator !== "greater_than" &&
      condition.operator !== "less_than"
    ) {
      return;
    }

    const value = condition.value;
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
