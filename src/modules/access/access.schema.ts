import { z } from "zod";

// ============================================================================
// Enums
// ============================================================================

export const AccessTypeSchema = z.enum([
  "WORKSHOP",
  "DINNER",
  "SESSION",
  "NETWORKING",
  "ACCOMMODATION",
  "TRANSPORT",
  "OTHER",
]);

// ============================================================================
// Domain Model Schemas (JSONB structures)
// ============================================================================

export const AccessConditionSchema = z
  .object({
    fieldId: z.string().min(1),
    operator: z.enum(["equals", "not_equals"]),
    value: z.union([z.string(), z.number()]),
  })
  .strict();

// ============================================================================
// Selection Schema (used cross-module via barrel)
// ============================================================================

export const AccessSelectionSchema = z
  .object({
    accessId: z.string().uuid(),
    quantity: z.number().int().min(1).default(1),
  })
  .strict();

// ============================================================================
// Types
// ============================================================================

export type AccessType = z.infer<typeof AccessTypeSchema>;
export type AccessCondition = z.infer<typeof AccessConditionSchema>;
export type AccessSelection = z.infer<typeof AccessSelectionSchema>;
