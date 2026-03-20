import { randomUUID } from "crypto";
import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { calculateApplicableAmount } from "@sponsorships";
import { evaluateConditions } from "@shared/utils/conditions.js";
import type {
  UpdateEventPricingInput,
  CreateEmbeddedRuleInput,
  UpdateEmbeddedRuleInput,
  EmbeddedPricingRule,
  CalculatePriceRequest,
  PriceBreakdown,
  SelectedExtra,
} from "./pricing.schema.js";
import type { Prisma, EventPricing } from "@/generated/prisma/client.js";

// ============================================================================
// Types
// ============================================================================

// EventPricing with parsed rules array
export type EventPricingWithRules = Omit<EventPricing, "rules"> & {
  rules: EmbeddedPricingRule[];
};

// ============================================================================
// Event Pricing CRUD (Unified with embedded rules)
// ============================================================================

/**
 * Get event pricing by event ID with parsed rules.
 */
export async function getEventPricing(
  eventId: string,
): Promise<EventPricingWithRules | null> {
  const pricing = await prisma.eventPricing.findUnique({ where: { eventId } });
  if (!pricing) return null;

  return {
    ...pricing,
    rules: (pricing.rules as unknown as EmbeddedPricingRule[]) ?? [],
  };
}

/**
 * Update event pricing (base price, currency, rules, and payment methods).
 */
export async function updateEventPricing(
  eventId: string,
  input: UpdateEventPricingInput,
): Promise<EventPricingWithRules> {
  const pricing = await prisma.eventPricing.findUnique({ where: { eventId } });
  if (!pricing) {
    throw new AppError(
      "Event pricing not found",
      404,
      ErrorCodes.PRICING_NOT_FOUND,
    );
  }

  const updateData: Prisma.EventPricingUpdateInput = {};

  if (input.basePrice !== undefined) updateData.basePrice = input.basePrice;
  if (input.currency !== undefined) updateData.currency = input.currency;
  if (input.rules !== undefined) {
    // Ensure all rules have IDs (in case new ones are added)
    const rulesWithIds = input.rules.map((rule) => ({
      ...rule,
      id: rule.id ?? randomUUID(),
    }));
    updateData.rules = rulesWithIds as Prisma.InputJsonValue;
  }

  // Payment Methods
  if (input.onlinePaymentEnabled !== undefined)
    updateData.onlinePaymentEnabled = input.onlinePaymentEnabled;
  if (input.onlinePaymentUrl !== undefined)
    updateData.onlinePaymentUrl = input.onlinePaymentUrl;
  if (input.cashPaymentEnabled !== undefined)
    updateData.cashPaymentEnabled = input.cashPaymentEnabled;
  if (input.bankName !== undefined) updateData.bankName = input.bankName;
  if (input.bankAccountName !== undefined)
    updateData.bankAccountName = input.bankAccountName;
  if (input.bankAccountNumber !== undefined)
    updateData.bankAccountNumber = input.bankAccountNumber;

  const updated = await prisma.eventPricing.update({
    where: { eventId },
    data: updateData,
  });

  return {
    ...updated,
    rules: (updated.rules as unknown as EmbeddedPricingRule[]) ?? [],
  };
}

// ============================================================================
// Embedded Rule Management Helpers
// ============================================================================

/**
 * Add a single pricing rule to an event's pricing.
 */
export async function addPricingRule(
  eventId: string,
  rule: CreateEmbeddedRuleInput,
): Promise<EventPricingWithRules> {
  const pricing = await getEventPricing(eventId);
  if (!pricing) {
    throw new AppError(
      "Event pricing not found",
      404,
      ErrorCodes.PRICING_NOT_FOUND,
    );
  }

  const newRule: EmbeddedPricingRule = {
    ...rule,
    id: randomUUID(),
    description: rule.description ?? null,
    priority: rule.priority ?? 0,
    conditionLogic: rule.conditionLogic ?? "AND",
    active: rule.active ?? true,
  };

  const updatedRules = [...pricing.rules, newRule];
  return updateEventPricing(eventId, { rules: updatedRules });
}

/**
 * Update a single pricing rule by ID.
 */
export async function updatePricingRule(
  eventId: string,
  ruleId: string,
  updates: UpdateEmbeddedRuleInput,
): Promise<EventPricingWithRules> {
  const pricing = await getEventPricing(eventId);
  if (!pricing) {
    throw new AppError(
      "Event pricing not found",
      404,
      ErrorCodes.PRICING_NOT_FOUND,
    );
  }

  const ruleIndex = pricing.rules.findIndex((r) => r.id === ruleId);
  if (ruleIndex === -1) {
    throw new AppError("Pricing rule not found", 404, ErrorCodes.NOT_FOUND);
  }

  const updatedRules = [...pricing.rules];
  updatedRules[ruleIndex] = { ...updatedRules[ruleIndex], ...updates };

  return updateEventPricing(eventId, { rules: updatedRules });
}

/**
 * Delete a single pricing rule by ID.
 */
export async function deletePricingRule(
  eventId: string,
  ruleId: string,
): Promise<EventPricingWithRules> {
  const pricing = await getEventPricing(eventId);
  if (!pricing) {
    throw new AppError(
      "Event pricing not found",
      404,
      ErrorCodes.PRICING_NOT_FOUND,
    );
  }

  const ruleExists = pricing.rules.some((r) => r.id === ruleId);
  if (!ruleExists) {
    throw new AppError("Pricing rule not found", 404, ErrorCodes.NOT_FOUND);
  }

  const updatedRules = pricing.rules.filter((r) => r.id !== ruleId);
  return updateEventPricing(eventId, { rules: updatedRules });
}

// ============================================================================
// Price Calculation
// ============================================================================

/**
 * Calculate price breakdown for a registration.
 *
 * Formula:
 *   Base Price = EventPricing.basePrice (or first matching rule's price)
 *   + Selected Access Items
 *   - Sponsorship Discounts
 *   = Total
 */
export async function calculatePrice(
  eventId: string,
  input: CalculatePriceRequest,
): Promise<PriceBreakdown> {
  const { formData, selectedExtras, sponsorshipCodes } = input;

  // Get event pricing configuration with embedded rules
  const pricing = await getEventPricing(eventId);
  if (!pricing) {
    throw new AppError(
      "Event pricing not found",
      404,
      ErrorCodes.PRICING_NOT_FOUND,
    );
  }

  const { basePrice, currency, rules } = pricing;

  // Get active rules sorted by priority (highest first)
  const activeRules = rules
    .filter((r) => r.active)
    .sort((a, b) => b.priority - a.priority);

  // Find first matching rule (highest priority wins)
  // If a rule matches, its price overrides the base price
  const appliedRules: PriceBreakdown["appliedRules"] = [];
  let calculatedBasePrice = basePrice;

  for (const rule of activeRules) {
    if (evaluateConditions(rule.conditions, rule.conditionLogic, formData)) {
      calculatedBasePrice = rule.price;
      appliedRules.push({
        ruleId: rule.id,
        ruleName: rule.name,
        effect: rule.price - basePrice,
        reason: `Base price set to ${rule.price}`,
      });
      break; // First match wins
    }
  }

  // Calculate access items total
  const accessItemsDetails = await calculateAccessItemsTotal(selectedExtras);
  const accessTotal = accessItemsDetails.reduce(
    (sum, e) => sum + e.subtotal,
    0,
  );

  // Calculate subtotal first (needed for sponsorship validation)
  const subtotal = calculatedBasePrice + accessTotal;

  // Validate sponsorship codes with smart matching
  // Only applies the portion that matches what the registration actually selected
  const sponsorships = await validateSponsorshipCodes(
    sponsorshipCodes,
    eventId,
    {
      calculatedBasePrice,
      accessItemsDetails,
      subtotal,
    },
  );
  const sponsorshipTotal = sponsorships
    .filter((s) => s.valid)
    .reduce((sum, s) => sum + s.amount, 0);

  // Calculate final total
  const total = Math.max(0, subtotal - sponsorshipTotal);

  return {
    basePrice,
    appliedRules,
    calculatedBasePrice,
    accessItems: accessItemsDetails,
    accessTotal,
    subtotal,
    sponsorships,
    sponsorshipTotal,
    total,
    currency,
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate access items total from selected items.
 */
async function calculateAccessItemsTotal(
  selectedExtras: SelectedExtra[],
): Promise<PriceBreakdown["accessItems"]> {
  if (!selectedExtras.length) return [];

  const accessIds = selectedExtras.map((e) => e.accessId);
  const accessItems = await prisma.eventAccess.findMany({
    where: { id: { in: accessIds }, active: true },
  });

  const accessMap = new Map(accessItems.map((a) => [a.id, a]));

  return selectedExtras
    .map((selected) => {
      const access = accessMap.get(selected.accessId);
      if (!access) return null;

      if (access.includedInBase) {
        // Included: free for registrant, companion pays companionPrice
        const companionCount =
          selected.quantity > 1 ? selected.quantity - 1 : 0;
        return {
          accessId: access.id,
          name: access.name,
          unitPrice: access.companionPrice,
          quantity: selected.quantity,
          subtotal: access.companionPrice * companionCount,
        };
      }

      // Non-included: registrant pays price, companion pays companionPrice (or price if unset)
      const companionCount = selected.quantity > 1 ? selected.quantity - 1 : 0;
      const companionUnitPrice =
        access.companionPrice > 0 ? access.companionPrice : access.price;
      return {
        accessId: access.id,
        name: access.name,
        unitPrice: access.price,
        quantity: selected.quantity,
        subtotal: access.price + companionUnitPrice * companionCount,
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);
}

/**
 * Context needed for smart sponsorship amount calculation.
 */
interface SponsorshipValidationContext {
  calculatedBasePrice: number;
  accessItemsDetails: Array<{ accessId: string; subtotal: number }>;
  subtotal: number;
}

/**
 * Validate sponsorship codes against the database and calculate applicable amounts.
 * Uses smart matching: only applies amount for items the registration actually selected.
 * Only PENDING sponsorships are valid for use.
 *
 * Single batched query instead of N+1 individual lookups.
 */
async function validateSponsorshipCodes(
  codes: string[],
  eventId: string,
  context: SponsorshipValidationContext,
): Promise<PriceBreakdown["sponsorships"]> {
  if (!codes.length) return [];

  const upperCodes = codes.map((c) => c.toUpperCase());

  // Batch lookup: single query instead of one per code
  const sponsorships = await prisma.sponsorship.findMany({
    where: {
      eventId,
      code: { in: upperCodes },
      status: "PENDING", // Only unused codes are valid
    },
    select: {
      code: true,
      totalAmount: true,
      coversBasePrice: true,
      coveredAccessIds: true,
    },
  });

  const sponsorshipMap = new Map(sponsorships.map((s) => [s.code, s]));

  return codes.map((code) => {
    const sponsorship = sponsorshipMap.get(code.toUpperCase());

    if (!sponsorship) {
      return { code, amount: 0, valid: false };
    }

    const applicableAmount = calculateApplicableAmount(
      {
        totalAmount: sponsorship.totalAmount,
        coversBasePrice: sponsorship.coversBasePrice,
        coveredAccessIds: sponsorship.coveredAccessIds,
      },
      {
        baseAmount: context.calculatedBasePrice,
        totalAmount: context.subtotal,
        accessTypeIds: context.accessItemsDetails.map((e) => e.accessId),
        priceBreakdown: {
          calculatedBasePrice: context.calculatedBasePrice,
          accessItems: context.accessItemsDetails.map((e) => ({
            accessId: e.accessId,
            subtotal: e.subtotal,
          })),
        },
      },
    );

    return { code, amount: applicableAmount, valid: true };
  });
}
