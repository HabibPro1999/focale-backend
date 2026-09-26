import { z } from "zod";
import { findConditionConflicts } from "./condition-satisfiability";
import { ConditionSchema } from "./condition.schema";

const hasUpdateField = (data: Record<string, unknown>) =>
  Object.values(data).some((value) => value !== undefined);

// ============================================================================
// Embedded Pricing Rule Schema
// Rules define conditional base price overrides: if conditions match -> use this price.
// Stored inside EventPricing.rules JSON column — no separate rule table.
// ============================================================================

export const EmbeddedPricingRuleSchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional().nullable(),
  priority: z.number().int().min(0).default(0),
  conditions: z.array(ConditionSchema).min(1),
  conditionLogic: z.enum(["AND", "OR"]).default("AND"),
  price: z.number().int().min(0), // Fixed price when conditions match
  active: z.boolean().default(true),
});

/**
 * The stored `event_pricing.rules` document (plan 5.2): the rules exactly as
 * the pricing routes write them (parsed, defaults filled in).
 */
export const StoredPricingRulesSchema = z.array(EmbeddedPricingRuleSchema);

// For creating rules (id is optional, will be generated)
// A POST is a new rule by definition, so it can never be "legacy" — always
// validate it against the contradiction guard. Do NOT add this refine to
// `EmbeddedPricingRuleSchema` (reused inside `UpdateEventPricingSchema.rules`,
// a full-replace path where a client legitimately echoes an untouched legacy
// rule) or to `UpdateEmbeddedRuleSchema` (a partial patch — the service
// shallow-merges it onto the stored rule, so only the service knows the
// merged conditions; see the grandfathering logic in pricing.service.ts).
export const CreateEmbeddedRuleSchema = EmbeddedPricingRuleSchema.omit({
  id: true,
}).superRefine((rule, ctx) => {
  const conflicts = findConditionConflicts(rule.conditions, rule.conditionLogic);
  if (conflicts.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["conditions"],
      message: "Conditions are contradictory and can never all be true together",
    });
  }
});

// For updating a single rule
export const UpdateEmbeddedRuleSchema = z
  .strictObject({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).optional().nullable(),
    priority: z.number().int().min(0).optional(),
    conditions: z.array(ConditionSchema).min(1).optional(),
    conditionLogic: z.enum(["AND", "OR"]).optional(),
    price: z.number().int().min(0).optional(),
    active: z.boolean().optional(),
  })
  .refine(hasUpdateField, {
    message: "At least one field must be provided for update",
  });

// ============================================================================
// Event Pricing Schemas (Unified: base price + embedded rules)
// ============================================================================

export const UpdateEventPricingSchema = z
  .strictObject({
    basePrice: z.number().int().min(0).nullable().optional(),
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
  })
  .refine(hasUpdateField, {
    message: "At least one field must be provided for update",
  });

// Prefixed to stay unique in the shared contracts barrel: events/forms already
// export EventIdParamSchema/FormIdParamSchema keyed on `id`; pricing routes key
// on `eventId`/`ruleId`/`formId`.
export const PricingEventIdParamSchema = z.strictObject({
  eventId: z.string().uuid(),
});

export const PricingRuleIdParamSchema = z.strictObject({
  eventId: z.string().uuid(),
  ruleId: z.string().uuid(),
});

export const PricingFormIdParamSchema = z.strictObject({
  formId: z.string().uuid(),
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
  /**
   * Set on the lines of a public signup (legacy and current); admin creates,
   * edits and repricing store the pricing lines without it.
   */
  status: z.literal("confirmed").optional(),
});

export const SponsorshipLineSchema = z.object({
  code: z.string(),
  amount: z.number(),
  valid: z.boolean(),
});

/** Why an access item left a registration: its paid capacity filled up, or it was deactivated. */
export const AccessDropReasonSchema = z.enum(["capacity_reached", "deactivated"]);

/** An access line removed from a registration: the line as it was, and why. */
export const DroppedAccessItemSchema = AccessLineItemSchema.extend({
  reason: AccessDropReasonSchema,
});

/**
 * The price breakdown (plan 5.2): the public price quote, and the stored
 * `registrations.price_breakdown` document. The one breakdown type every
 * reader and writer uses. Registrations created before dropped items were
 * recorded (April 2026) have no `droppedAccessItems` key, so it is optional
 * and has no default: a stored document is exactly this schema's output.
 */
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
  droppedAccessItems: z.array(DroppedAccessItemSchema).optional(),
});

// ============================================================================
// Types
// ============================================================================

export type EmbeddedPricingRule = z.infer<typeof EmbeddedPricingRuleSchema>;
export type StoredPricingRules = z.infer<typeof StoredPricingRulesSchema>;
export type CreateEmbeddedRuleInput = z.infer<typeof CreateEmbeddedRuleSchema>;
export type UpdateEmbeddedRuleInput = z.infer<typeof UpdateEmbeddedRuleSchema>;

export type UpdateEventPricingInput = z.infer<typeof UpdateEventPricingSchema>;
export type CalculatePriceRequest = z.infer<typeof CalculatePriceRequestSchema>;
export type PriceBreakdown = z.infer<typeof PriceBreakdownSchema>;
export type AppliedRule = z.infer<typeof AppliedRuleSchema>;
export type AccessLineItem = z.infer<typeof AccessLineItemSchema>;
export type SponsorshipLine = z.infer<typeof SponsorshipLineSchema>;
export type AccessDropReason = z.infer<typeof AccessDropReasonSchema>;
export type DroppedAccessItem = z.infer<typeof DroppedAccessItemSchema>;
export type SelectedAccessItem = z.infer<typeof SelectedAccessItemSchema>;

/**
 * EventPricing row with its `rules` JSON column parsed into typed rules.
 * Shape of the GET/PATCH pricing response payload.
 */
export interface EventPricingWithRules {
  id: string;
  eventId: string;
  basePrice: number;
  currency: string;
  rules: EmbeddedPricingRule[];
  onlinePaymentEnabled: boolean;
  onlinePaymentUrl: string | null;
  cashPaymentEnabled: boolean;
  bankName: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  createdAt: Date;
  updatedAt: Date;
}
