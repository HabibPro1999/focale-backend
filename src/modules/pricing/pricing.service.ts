import { randomUUID } from "crypto";
import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { calculateApplicableAmount } from "@shared/utils/sponsorship-math.js";
import { evaluateConditions } from "@shared/utils/conditions.js";
import { assertModuleEnabledForClient } from "@clients";
import { assertEventWritable } from "@events";
import type {
  UpdateEventPricingInput,
  CreateEmbeddedRuleInput,
  UpdateEmbeddedRuleInput,
  EmbeddedPricingRule,
  CalculatePriceRequest,
  PriceBreakdown,
  SelectedAccessItem,
} from "./pricing.schema.js";
import { Prisma, type EventPricing } from "@/generated/prisma/client.js";
import type { TxClient } from "@shared/types/prisma.js";

// ============================================================================
// Types
// ============================================================================

// EventPricing with parsed rules array
export type EventPricingWithRules = Omit<EventPricing, "rules"> & {
  rules: EmbeddedPricingRule[];
};

type PricingTxClient = Pick<
  TxClient,
  "event" | "eventPricing" | "registration"
>;

function parseEventPricing(pricing: EventPricing): EventPricingWithRules {
  return {
    ...pricing,
    rules: (pricing.rules as unknown as EmbeddedPricingRule[]) ?? [],
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
  db: Pick<TxClient, "eventPricing"> = prisma,
): Promise<EventPricingWithRules | null> {
  const pricing = await db.eventPricing.findUnique({ where: { eventId } });
  if (!pricing) return null;

  return parseEventPricing(pricing);
}

/**
 * Update event pricing (base price, currency, rules, and payment methods).
 */
export async function updateEventPricing(
  eventId: string,
  input: UpdateEventPricingInput,
): Promise<EventPricingWithRules> {
  return prisma.$transaction((tx) => updateEventPricingTx(tx, eventId, input), {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  });
}

async function updateEventPricingTx(
  tx: PricingTxClient,
  eventId: string,
  input: UpdateEventPricingInput,
): Promise<EventPricingWithRules> {
  const event = await tx.event.findUnique({
    where: { id: eventId },
    select: {
      status: true,
      client: { select: { enabledModules: true } },
      pricing: { select: { currency: true } },
    },
  });
  if (!event) {
    throw new AppError("Event not found", 404, ErrorCodes.NOT_FOUND);
  }
  assertEventWritable(event);
  assertModuleEnabledForClient(event.client, "pricing");

  const updateData: Prisma.EventPricingUpdateInput = {};
  const createData: Prisma.EventPricingCreateInput = {
    event: { connect: { id: eventId } },
    basePrice: input.basePrice ?? 0,
    currency: input.currency ?? "TND",
  };

  if (input.basePrice !== undefined) {
    updateData.basePrice = input.basePrice ?? 0;
  }
  if (input.currency !== undefined) {
    const currentCurrency = event.pricing?.currency ?? "TND";
    if (input.currency !== currentCurrency) {
      const registrationCount = await tx.registration.count({
        where: { eventId },
      });
      if (registrationCount > 0) {
        throw new AppError(
          "Cannot change currency after registrations exist",
          400,
          ErrorCodes.VALIDATION_ERROR,
        );
      }
    }
    updateData.currency = input.currency;
  }
  if (input.rules !== undefined) {
    // Ensure all rules have IDs (in case new ones are added)
    const rulesWithIds = input.rules.map((rule) => ({
      ...rule,
      id: rule.id ?? randomUUID(),
    }));
    updateData.rules = rulesWithIds as Prisma.InputJsonValue;
    createData.rules = rulesWithIds as Prisma.InputJsonValue;
  }

  // Payment Methods
  if (input.onlinePaymentEnabled !== undefined) {
    updateData.onlinePaymentEnabled = input.onlinePaymentEnabled;
    createData.onlinePaymentEnabled = input.onlinePaymentEnabled;
  }
  if (input.onlinePaymentUrl !== undefined) {
    updateData.onlinePaymentUrl = input.onlinePaymentUrl;
    createData.onlinePaymentUrl = input.onlinePaymentUrl;
  }
  if (input.cashPaymentEnabled !== undefined) {
    updateData.cashPaymentEnabled = input.cashPaymentEnabled;
    createData.cashPaymentEnabled = input.cashPaymentEnabled;
  }
  if (input.bankName !== undefined) {
    updateData.bankName = input.bankName;
    createData.bankName = input.bankName;
  }
  if (input.bankAccountName !== undefined) {
    updateData.bankAccountName = input.bankAccountName;
    createData.bankAccountName = input.bankAccountName;
  }
  if (input.bankAccountNumber !== undefined) {
    updateData.bankAccountNumber = input.bankAccountNumber;
    createData.bankAccountNumber = input.bankAccountNumber;
  }

  const updated = await tx.eventPricing.upsert({
    where: { eventId },
    create: createData,
    update: updateData,
  });

  return parseEventPricing(updated);
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
  return mutatePricingRules(eventId, (rules) => {
    const newRule: EmbeddedPricingRule = {
      ...rule,
      id: randomUUID(),
      description: rule.description ?? null,
      priority: rule.priority ?? 0,
      conditionLogic: rule.conditionLogic ?? "AND",
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
  updates: UpdateEmbeddedRuleInput,
): Promise<EventPricingWithRules> {
  return mutatePricingRules(eventId, (rules) => {
    const ruleIndex = rules.findIndex((r) => r.id === ruleId);
    if (ruleIndex === -1) {
      throw new AppError("Pricing rule not found", 404, ErrorCodes.NOT_FOUND);
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
  return mutatePricingRules(eventId, (rules) => {
    const ruleExists = rules.some((r) => r.id === ruleId);
    if (!ruleExists) {
      throw new AppError("Pricing rule not found", 404, ErrorCodes.NOT_FOUND);
    }

    return rules.filter((r) => r.id !== ruleId);
  });
}

async function mutatePricingRules(
  eventId: string,
  mutate: (rules: EmbeddedPricingRule[]) => EmbeddedPricingRule[],
): Promise<EventPricingWithRules> {
  return prisma.$transaction(
    async (tx) => {
      const pricing = await getEventPricing(eventId, tx);
      if (!pricing) {
        throw new AppError(
          "Event pricing not found",
          404,
          ErrorCodes.PRICING_NOT_FOUND,
        );
      }

      return updateEventPricingTx(tx, eventId, {
        rules: mutate(pricing.rules),
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
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
  const { formData, selectedAccessItems, sponsorshipCodes } = input;

  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: {
      client: { select: { enabledModules: true } },
    },
  });
  if (!event) {
    throw new AppError("Event not found", 404, ErrorCodes.NOT_FOUND);
  }
  assertModuleEnabledForClient(event.client, "pricing");

  // Get event pricing configuration with embedded rules
  const pricing =
    (await getEventPricing(eventId)) ??
    (await updateEventPricing(eventId, { basePrice: 0, currency: "TND" }));

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
  const accessItemsDetails = await calculateAccessItemsTotal(
    eventId,
    selectedAccessItems,
  );
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
    droppedAccessItems: [],
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate access items total from selected items.
 */
async function calculateAccessItemsTotal(
  eventId: string,
  selectedAccessItems: SelectedAccessItem[],
): Promise<PriceBreakdown["accessItems"]> {
  if (!selectedAccessItems.length) return [];

  const accessIds = selectedAccessItems.map((e) => e.accessId);
  const accessItems = await prisma.eventAccess.findMany({
    where: { id: { in: accessIds }, eventId },
  });

  const accessMap = new Map(accessItems.map((a) => [a.id, a]));

  return selectedAccessItems
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

      // Non-included: registrant pays price, companion pays companionPrice
      // companionPrice = 0 means explicitly free companions (not "unset")
      const companionCount = selected.quantity > 1 ? selected.quantity - 1 : 0;
      const companionUnitPrice = access.companionPrice;
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
