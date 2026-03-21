import { z } from "zod";
import {
  ConditionSchema as PricingConditionSchema,
  type Condition as PricingCondition,
} from "@shared/schemas/condition.schema.js";

export { PricingConditionSchema };
export type { PricingCondition };

// ============================================================================
// Embedded Pricing Rule Schema
// Rules define conditional base price overrides: if conditions match → use this price
// ============================================================================

export const EmbeddedPricingRuleSchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional().nullable(),
  priority: z.number().int().min(0).default(0),
  conditions: z.array(PricingConditionSchema).min(1),
  conditionLogic: z.enum(["AND", "OR"]).default("AND"),
  price: z.number().int().min(0), // Fixed price when conditions match
  active: z.boolean().default(true),
});

// For creating rules (id is optional, will be generated)
export const CreateEmbeddedRuleSchema = EmbeddedPricingRuleSchema.omit({
  id: true,
});

// For updating a single rule
export const UpdateEmbeddedRuleSchema = z.strictObject({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional().nullable(),
  priority: z.number().int().min(0).optional(),
  conditions: z.array(PricingConditionSchema).min(1).optional(),
  conditionLogic: z.enum(["AND", "OR"]).optional(),
  price: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
});

// ============================================================================
// Event Pricing Schemas (Unified: base price + embedded rules)
// ============================================================================

export const UpdateEventPricingSchema = z.strictObject({
  basePrice: z.number().int().min(0).optional(),
  currency: z.string().length(3).optional(),
  rules: z.array(EmbeddedPricingRuleSchema).max(10).optional(),
  // Payment Methods
  onlinePaymentEnabled: z.boolean().optional(),
  onlinePaymentUrl: z.string().url().optional().nullable(),
  cashPaymentEnabled: z.boolean().optional(),
  // Bank Transfer Details
  bankName: z.string().max(200).optional().nullable(),
  bankAccountName: z.string().max(200).optional().nullable(),
  bankAccountNumber: z.string().max(50).optional().nullable(),
});

export const EventIdParamSchema = z.strictObject({
  eventId: z.string().uuid(),
});

export const RuleIdParamSchema = z.strictObject({
  eventId: z.string().uuid(),
  ruleId: z.string().uuid(),
});

// ============================================================================
// Price Calculation Schemas
// ============================================================================

export const SelectedAccessItemSchema = z.strictObject({
  accessId: z.string().uuid(),
  quantity: z.number().int().min(1).default(1),
});

export const CalculatePriceRequestSchema = z.strictObject({
  formData: z
    .record(z.string(), z.unknown())
    .refine((obj) => Object.keys(obj).length <= 100, "Too many fields"),
  selectedAccessItems: z.array(SelectedAccessItemSchema).optional().default([]),
  sponsorshipCodes: z.array(z.string()).max(10).optional().default([]),
});

export const AppliedRuleSchema = z.object({
  ruleId: z.string(),
  ruleName: z.string(),
  effect: z.number(),
  reason: z.string().optional(),
});

export const AccessLineItemSchema = z.object({
  accessId: z.string(),
  name: z.string(),
  unitPrice: z.number(),
  quantity: z.number(),
  subtotal: z.number(),
});

export const SponsorshipLineSchema = z.object({
  code: z.string(),
  amount: z.number(),
  valid: z.boolean(),
});

export const PriceBreakdownSchema = z.object({
  basePrice: z.number(),
  appliedRules: z.array(AppliedRuleSchema),
  calculatedBasePrice: z.number(),
  accessItems: z.array(AccessLineItemSchema),
  accessTotal: z.number(),
  subtotal: z.number(),
  sponsorships: z.array(SponsorshipLineSchema),
  sponsorshipTotal: z.number(),
  total: z.number(),
  currency: z.string(),
});

// ============================================================================
// Types
// ============================================================================

export type EmbeddedPricingRule = z.infer<typeof EmbeddedPricingRuleSchema>;
export type CreateEmbeddedRuleInput = z.infer<typeof CreateEmbeddedRuleSchema>;
export type UpdateEmbeddedRuleInput = z.infer<typeof UpdateEmbeddedRuleSchema>;

export type UpdateEventPricingInput = z.infer<typeof UpdateEventPricingSchema>;
export type CalculatePriceRequest = z.infer<typeof CalculatePriceRequestSchema>;
export type PriceBreakdown = z.infer<typeof PriceBreakdownSchema>;
export type SelectedAccessItem = z.infer<typeof SelectedAccessItemSchema>;
