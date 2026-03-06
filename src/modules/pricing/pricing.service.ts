import { randomUUID } from "crypto";
import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors.js";
import { ErrorCodes } from "@shared/errors.js";
import { calculateApplicableAmount } from "@sponsorships";
import { evaluateConditions } from "@shared/utils/condition-evaluator.js";
import { logger } from "@shared/utils/logger.js";
import {
  type EmbeddedPricingRule,
  type PriceBreakdown,
  MAX_PRICING_RULES,
} from "./pricing.schema.js";
import type { Prisma, EventPricing } from "@/generated/prisma/client.js";

// ============================================================================
// Local Request Types (validated by routes, not here)
// ============================================================================

type UpdateEventPricingInput = {
  basePrice?: number;
  currency?: string;
  rules?: EmbeddedPricingRule[];
  onlinePaymentEnabled?: boolean;
  onlinePaymentUrl?: string | null;
  bankName?: string | null;
  bankAccountName?: string | null;
  bankAccountNumber?: string | null;
};

type SelectedExtra = {
  extraId: string;
  quantity: number;
};

type CalculatePriceRequest = {
  formData: Record<string, unknown>;
  selectedExtras: SelectedExtra[];
  sponsorshipCodes: string[];
};

// ============================================================================
// Types
// ============================================================================

// EventPricing with parsed rules array
export type EventPricingWithRules = Omit<EventPricing, "rules"> & {
  rules: EmbeddedPricingRule[];
};

/**
 * Safely parse rules from JSONB column.
 * DB data was written by validated code paths — array check is sufficient.
 */
function parseRulesFromDb(rules: unknown): EmbeddedPricingRule[] {
  return Array.isArray(rules) ? (rules as EmbeddedPricingRule[]) : [];
}

// ============================================================================
// Public Payment Config
// ============================================================================

export type EventPaymentConfig = {
  event: {
    id: string;
    name: string;
    slug: string;
    status: string;
    startDate: Date;
    endDate: Date;
    location: string | null;
    client: {
      id: string;
      name: string;
    };
  };
  pricing: {
    basePrice: number;
    currency: string;
    rules: EmbeddedPricingRule[];
    paymentMethods: string[];
    bankDetails: {
      bankName: string;
      accountName: string;
      iban: string;
    } | null;
    onlinePaymentUrl: string | null;
  } | null;
} | null;

/**
 * Get public payment configuration for an event.
 * Returns event details, client branding, and payment method info.
 */
export async function getEventPaymentConfig(
  eventId: string,
): Promise<EventPaymentConfig> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    include: {
      pricing: true,
      client: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  if (!event) return null;

  const pricing = event.pricing;
  const paymentMethods: string[] = ["BANK_TRANSFER"];
  if (pricing?.onlinePaymentEnabled && pricing?.onlinePaymentUrl) {
    paymentMethods.push("ONLINE");
  }

  return {
    event: {
      id: event.id,
      name: event.name,
      slug: event.slug,
      status: event.status,
      startDate: event.startDate,
      endDate: event.endDate,
      location: event.location,
      client: event.client,
    },
    pricing: pricing
      ? {
          basePrice: pricing.basePrice,
          currency: pricing.currency,
          rules: parseRulesFromDb(pricing.rules),
          paymentMethods,
          bankDetails: pricing.bankName
            ? {
                bankName: pricing.bankName,
                accountName: pricing.bankAccountName ?? "",
                iban: pricing.bankAccountNumber ?? "",
              }
            : null,
          onlinePaymentUrl: pricing.onlinePaymentUrl ?? null,
        }
      : null,
  };
}

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

  const rules = parseRulesFromDb(pricing.rules);

  return {
    ...pricing,
    rules,
  };
}

/**
 * Update event pricing (base price, currency, rules, and payment methods).
 */
export async function updateEventPricing(
  eventId: string,
  input: UpdateEventPricingInput,
): Promise<EventPricingWithRules> {
  const existingPricing = await prisma.eventPricing.findUnique({
    where: { eventId },
  });
  if (!existingPricing)
    throw new AppError(
      "Event pricing not found",
      404,
      true,
      ErrorCodes.PRICING_NOT_FOUND,
    );

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
    rules: parseRulesFromDb(updated.rules),
  };
}

// ============================================================================
// Embedded Rule Management Helpers
// ============================================================================

/**
 * Fetch event pricing, parse rules, apply a transformation, and write back.
 * Wraps the common read-modify-write pattern in a transaction.
 *
 * @param eventId - The event to update
 * @param fn - Callback that receives the current rules and transaction client,
 *             returns the modified rules array (or throws to abort).
 */
async function withPricingRules(
  eventId: string,
  fn: (rules: EmbeddedPricingRule[]) => Promise<EmbeddedPricingRule[]>,
): Promise<EventPricingWithRules> {
  return prisma.$transaction(async (tx) => {
    const pricing = await tx.eventPricing.findUnique({ where: { eventId } });
    if (!pricing)
      throw new AppError(
        "Event pricing not found",
        404,
        true,
        ErrorCodes.PRICING_NOT_FOUND,
      );

    const rules = parseRulesFromDb(pricing.rules);
    const updatedRules = await fn(rules);

    const updated = await tx.eventPricing.update({
      where: { eventId },
      data: { rules: updatedRules as Prisma.InputJsonValue },
    });

    return {
      ...updated,
      rules: parseRulesFromDb(updated.rules),
    };
  });
}

/**
 * Add a single pricing rule to an event's pricing.
 */
export async function addPricingRule(
  eventId: string,
  rule: Omit<EmbeddedPricingRule, "id">,
): Promise<EventPricingWithRules> {
  return withPricingRules(eventId, async (rules) => {
    if (rules.length >= MAX_PRICING_RULES) {
      throw new AppError(
        "Maximum number of pricing rules reached",
        400,
        true,
        ErrorCodes.VALIDATION_ERROR,
      );
    }

    const newRule: EmbeddedPricingRule = {
      ...rule,
      id: randomUUID(),
      description: rule.description ?? null,
      priority: rule.priority ?? 0,
      conditionLogic: rule.conditionLogic ?? "and",
      active: rule.active ?? true,
    };

    return [...rules, newRule];
  });
}

/**
 * Update a single pricing rule by ID.
 */
export async function updatePricingRule(
  eventId: string,
  ruleId: string,
  updates: Partial<Omit<EmbeddedPricingRule, "id">>,
): Promise<EventPricingWithRules> {
  return withPricingRules(eventId, async (rules) => {
    const ruleIndex = rules.findIndex((r) => r.id === ruleId);
    if (ruleIndex === -1) {
      throw new AppError(
        "Pricing rule not found",
        404,
        true,
        ErrorCodes.NOT_FOUND,
      );
    }

    const updatedRules = [...rules];
    updatedRules[ruleIndex] = { ...updatedRules[ruleIndex], ...updates };
    return updatedRules;
  });
}

/**
 * Delete a single pricing rule by ID.
 */
export async function deletePricingRule(
  eventId: string,
  ruleId: string,
): Promise<EventPricingWithRules> {
  return withPricingRules(eventId, async (rules) => {
    const ruleExists = rules.some((r) => r.id === ruleId);
    if (!ruleExists) {
      throw new AppError(
        "Pricing rule not found",
        404,
        true,
        ErrorCodes.NOT_FOUND,
      );
    }

    return rules.filter((r) => r.id !== ruleId);
  });
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
  if (!pricing)
    throw new AppError(
      "Event pricing not found",
      404,
      true,
      ErrorCodes.PRICING_NOT_FOUND,
    );

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
    if (
      evaluateConditions(rule.conditions, rule.conditionLogic, formData, {
        unknownOperatorDefault: false,
      })
    ) {
      calculatedBasePrice = rule.price;
      appliedRules.push({
        ruleId: rule.id,
        ruleName: rule.name,
        effect: rule.price - basePrice,
        reason: `Base price set to ${rule.price}`,
      });
      logger.info(
        {
          eventId,
          ruleId: rule.id,
          ruleName: rule.name,
          adjustment: rule.price - basePrice,
        },
        "Pricing rule matched",
      );
      break; // First match wins
    }
  }

  // Calculate access/extras total
  const extrasDetails = await calculateExtrasTotal(selectedExtras);
  const extrasTotal = extrasDetails.reduce((sum, e) => sum + e.subtotal, 0);

  // Calculate subtotal first (needed for sponsorship validation)
  const subtotal = calculatedBasePrice + extrasTotal;

  // Validate sponsorship codes with smart matching
  // Only applies the portion that matches what the registration actually selected
  const sponsorships = await validateSponsorshipCodes(
    sponsorshipCodes,
    eventId,
    {
      calculatedBasePrice,
      extrasDetails,
      subtotal,
    },
  );
  const sponsorshipTotal = sponsorships
    .filter((s) => s.valid)
    .reduce((sum, s) => sum + s.amount, 0);

  // Calculate final total
  const total = Math.max(0, subtotal - sponsorshipTotal);

  logger.info(
    {
      eventId,
      finalTotal: total,
      sponsorshipTotal,
    },
    "Price calculation completed",
  );

  return {
    basePrice,
    appliedRules,
    calculatedBasePrice,
    extras: extrasDetails,
    extrasTotal,
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
 * Calculate extras/access total from selected items.
 */
async function calculateExtrasTotal(
  selectedExtras: SelectedExtra[],
): Promise<PriceBreakdown["extras"]> {
  if (!selectedExtras.length) return [];

  const accessIds = selectedExtras.map((e) => e.extraId);
  const accessItems = await prisma.eventAccess.findMany({
    where: { id: { in: accessIds }, active: true },
  });

  const accessMap = new Map(accessItems.map((a) => [a.id, a]));

  return selectedExtras
    .map((selected) => {
      const access = accessMap.get(selected.extraId);
      if (!access) {
        logger.warn({ extraId: selected.extraId }, "Access item not found during extras calculation");
        return null;
      }

      return {
        extraId: access.id,
        name: access.name,
        unitPrice: access.price,
        quantity: selected.quantity,
        subtotal: access.price * selected.quantity,
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);
}

/**
 * Context needed for smart sponsorship amount calculation.
 */
interface SponsorshipValidationContext {
  calculatedBasePrice: number;
  extrasDetails: Array<{ extraId: string; subtotal: number }>;
  subtotal: number;
}

/**
 * Validate sponsorship codes against the database and calculate applicable amounts.
 * Uses smart matching: only applies amount for items the registration actually selected.
 * Only PENDING sponsorships are valid for use.
 */
async function validateSponsorshipCodes(
  codes: string[],
  eventId: string,
  context: SponsorshipValidationContext,
): Promise<PriceBreakdown["sponsorships"]> {
  if (!codes.length) return [];

  return Promise.all(
    codes.map(async (code) => {
      // Look up sponsorship in database with coverage details
      const sponsorship = await prisma.sponsorship.findFirst({
        where: {
          eventId,
          code: code.toUpperCase(),
          status: "PENDING", // Only unused codes are valid
        },
        select: {
          id: true,
          totalAmount: true,
          coversBasePrice: true,
          coveredAccessIds: true,
        },
      });

      if (!sponsorship) {
        logger.warn(
          {
            eventId,
            code,
            reason: "Code not found or already used",
          },
          "Invalid sponsorship code",
        );
        return {
          code,
          amount: 0,
          valid: false,
        };
      }

      // Calculate applicable amount using smart matching
      const applicableAmount = calculateApplicableAmount(
        {
          totalAmount: sponsorship.totalAmount,
          coversBasePrice: sponsorship.coversBasePrice,
          coveredAccessIds: sponsorship.coveredAccessIds,
        },
        {
          baseAmount: context.calculatedBasePrice,
          totalAmount: context.subtotal,
          accessTypeIds: context.extrasDetails.map((e) => e.extraId),
          priceBreakdown: {
            calculatedBasePrice: context.calculatedBasePrice,
            accessItems: context.extrasDetails.map((e) => ({
              accessId: e.extraId,
              subtotal: e.subtotal,
            })),
          },
        },
      );

      return {
        code,
        amount: applicableAmount,
        valid: true,
      };
    }),
  );
}
