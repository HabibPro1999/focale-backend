import { z } from "zod";

export const ConditionSchema = z.strictObject({
  fieldId: z.string().min(1),
  operator: z.enum(["equals", "not_equals"]),
  value: z.union([z.string(), z.number()]),
});

export type Condition = z.infer<typeof ConditionSchema>;
