import { z } from "zod";
import { ConditionOperatorSchema } from "@forms";

// ============================================================================
// Constants
// ============================================================================

export const MAX_PRICING_RULES = 10;

// ============================================================================
// Shared Types
// ============================================================================

export const PricingConditionSchema = z
  .object({
    fieldId: z.string().min(1),
    operator: ConditionOperatorSchema,
    value: z.union([z.string(), z.number()]),
  })
  .strict();

// ============================================================================
// Embedded Pricing Rule Schema
// Rules define conditional base price overrides: if conditions match → use this price
// ============================================================================

export const EmbeddedPricingRuleSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(200),
    description: z.string().max(1000).optional().nullable(),
    priority: z.number().int().min(0).default(0),
    conditions: z.array(PricingConditionSchema).min(1),
    conditionLogic: z.enum(["and", "or"]).default("and"),
    price: z.number().int().min(0), // Fixed price when conditions match
    active: z.boolean().default(true),
  })
  .strict();

// For creating rules (id is optional, will be generated)
export const CreateEmbeddedRuleSchema = EmbeddedPricingRuleSchema.omit({
  id: true,
});

// For updating a single rule
export const UpdateEmbeddedRuleSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).optional().nullable(),
    priority: z.number().int().min(0).optional(),
    conditions: z.array(PricingConditionSchema).min(1).optional(),
    conditionLogic: z.enum(["and", "or"]).optional(),
    price: z.number().int().min(0).optional(),
    active: z.boolean().optional(),
  })
  .strict();

// ============================================================================
// Event Pricing Schemas (Unified: base price + embedded rules)
// ============================================================================

export const UpdateEventPricingSchema = z
  .object({
    basePrice: z.number().int().min(0).optional(),
    currency: z.string().length(3).optional(),
    rules: z.array(EmbeddedPricingRuleSchema).max(MAX_PRICING_RULES).optional(),
    // Payment Methods
    onlinePaymentEnabled: z.boolean().optional(),
    onlinePaymentUrl: z.string().url().optional().nullable(),
    // Bank Transfer Details
    bankName: z.string().max(200).optional().nullable(),
    bankAccountName: z.string().max(200).optional().nullable(),
    bankAccountNumber: z.string().max(50).optional().nullable(),
  })
  .strict();

export { EventIdParamSchema } from "@shared/schemas/params.js";

export const FormIdParamSchema = z
  .object({
    formId: z.string().uuid(),
  })
  .strict();

export const RuleIdParamSchema = z
  .object({
    eventId: z.string().uuid(),
    ruleId: z.string().uuid(),
  })
  .strict();

// ============================================================================
// Price Calculation Schemas
// ============================================================================

const SelectedExtraSchema = z
  .object({
    extraId: z.string().uuid(),
    quantity: z.number().int().min(1).default(1),
  })
  .strict();

export const CalculatePriceRequestSchema = z
  .object({
    formData: z.record(z.string(), z.unknown()),
    selectedExtras: z.array(SelectedExtraSchema).optional().default([]),
    sponsorshipCodes: z.array(z.string()).optional().default([]),
  })
  .strict();

const AppliedRuleSchema = z
  .object({
    ruleId: z.string(),
    ruleName: z.string(),
    effect: z.number(),
    reason: z.string().optional(),
  })
  .strict();

const ExtraLineItemSchema = z
  .object({
    extraId: z.string(),
    name: z.union([z.string(), z.record(z.string(), z.string())]),
    unitPrice: z.number(),
    quantity: z.number(),
    subtotal: z.number(),
  })
  .strict();

const SponsorshipLineSchema = z
  .object({
    code: z.string(),
    amount: z.number(),
    valid: z.boolean(),
  })
  .strict();

export const PriceBreakdownSchema = z
  .object({
    basePrice: z.number(),
    appliedRules: z.array(AppliedRuleSchema),
    calculatedBasePrice: z.number(),
    extras: z.array(ExtraLineItemSchema),
    extrasTotal: z.number(),
    subtotal: z.number(),
    sponsorships: z.array(SponsorshipLineSchema),
    sponsorshipTotal: z.number(),
    total: z.number(),
    currency: z.string(),
  })
  .strict();

// ============================================================================
// Types
// ============================================================================

export type EmbeddedPricingRule = z.infer<typeof EmbeddedPricingRuleSchema>;
export type CreateEmbeddedRuleInput = z.infer<typeof CreateEmbeddedRuleSchema>;
export type UpdateEmbeddedRuleInput = z.infer<typeof UpdateEmbeddedRuleSchema>;
export type UpdateEventPricingInput = z.infer<typeof UpdateEventPricingSchema>;
export type CalculatePriceRequest = z.infer<typeof CalculatePriceRequestSchema>;
export type PriceBreakdown = z.infer<typeof PriceBreakdownSchema>;
export type SelectedExtra = z.infer<typeof SelectedExtraSchema>;
