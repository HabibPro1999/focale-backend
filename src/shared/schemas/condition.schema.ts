import { z } from "zod";

export const ConditionSchema = z.strictObject({
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
});

export type Condition = z.infer<typeof ConditionSchema>;
