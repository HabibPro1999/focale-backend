import { z } from "zod";
import { ConditionOperatorSchema } from "@forms";

// ============================================================================
// Constants
// ============================================================================

export const MAX_PRICING_RULES = 10;

// ============================================================================
// Domain Model Schemas (JSONB structure)
// ============================================================================

export const PricingConditionSchema = z
  .object({
    fieldId: z.string().min(1),
    operator: ConditionOperatorSchema,
    value: z.union([z.string(), z.number()]),
  })
  .strict();

// Rules define conditional base price overrides: if conditions match → use this price
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

// ============================================================================
// Price Breakdown Schema (used cross-module via barrel export)
// ============================================================================

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
    name: z.string(),
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
export type PriceBreakdown = z.infer<typeof PriceBreakdownSchema>;
