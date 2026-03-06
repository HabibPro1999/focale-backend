import { z } from "zod";
import { prisma } from "@/database/client.js";
import { logger } from "@shared/utils/logger.js";
import type { PriceBreakdown } from "./registrations.schema.js";
import type { Registration } from "@/generated/prisma/client.js";
import type { PriceBreakdown as PricingPriceBreakdown } from "@pricing";

// ============================================================================
// Types
// ============================================================================

export type RegistrationWithRelations = Registration & {
  accessSelections: Array<{
    id: string;
    accessId: string;
    unitPrice: number;
    quantity: number;
    subtotal: number;
    access: {
      id: string;
      name: string | Record<string, string>;
      type: string;
      startsAt: Date | null;
      endsAt: Date | null;
    };
  }>;
  form: {
    id: string;
    name: string;
  };
  event: {
    id: string;
    name: string;
    slug: string;
    clientId: string;
  };
};

// ============================================================================
// Stored PriceBreakdown Zod schema (registration storage format)
// Note: stored format uses accessItems/accessTotal, not extras/extrasTotal
// ============================================================================

const StoredPriceBreakdownSchema = z.object({
  basePrice: z.number(),
  appliedRules: z.array(
    z.object({
      ruleId: z.string(),
      ruleName: z.string(),
      effect: z.number(),
      reason: z.string().optional(),
    }),
  ),
  calculatedBasePrice: z.number(),
  accessItems: z.array(
    z.object({
      accessId: z.string(),
      name: z.string(),
      unitPrice: z.number(),
      quantity: z.number(),
      subtotal: z.number(),
    }),
  ),
  accessTotal: z.number(),
  subtotal: z.number(),
  sponsorships: z.array(
    z.object({
      code: z.string(),
      amount: z.number(),
      valid: z.boolean(),
    }),
  ),
  sponsorshipTotal: z.number(),
  total: z.number(),
  currency: z.string(),
}).strict();

const ZERO_PRICE_BREAKDOWN: PriceBreakdown = {
  basePrice: 0,
  appliedRules: [],
  calculatedBasePrice: 0,
  accessItems: [],
  accessTotal: 0,
  subtotal: 0,
  sponsorships: [],
  sponsorshipTotal: 0,
  total: 0,
  currency: "TND",
};

/**
 * Parse and validate a raw JSONB value as a stored PriceBreakdown.
 * On parse failure, logs a warning and returns a zero-value breakdown.
 */
export function parsePriceBreakdown(json: unknown): PriceBreakdown {
  const result = StoredPriceBreakdownSchema.safeParse(json);
  if (!result.success) {
    logger.warn(
      { error: result.error.issues },
      "PriceBreakdown failed runtime validation — using zero-value fallback",
    );
    return ZERO_PRICE_BREAKDOWN;
  }
  return result.data;
}

/**
 * Map a parsed PriceBreakdown's accessItems to the accessSelections shape,
 * using a pre-built access detail map for name/type/date lookups.
 * Shared by single-registration and batch enrichment paths.
 */
export function reconstructAccessSelections(
  parsedBreakdown: PriceBreakdown,
  accessDetailsMap: Map<
    string,
    {
      id: string;
      name: string | Record<string, string>;
      type: string;
      startsAt: Date | null;
      endsAt: Date | null;
    }
  >,
  registrationId: string,
): RegistrationWithRelations["accessSelections"] {
  return parsedBreakdown.accessItems.map((item) => ({
    id: `${registrationId}-${item.accessId}`,
    accessId: item.accessId,
    unitPrice: item.unitPrice,
    quantity: item.quantity,
    subtotal: item.subtotal,
    access: accessDetailsMap.get(item.accessId) ?? {
      id: item.accessId,
      name: item.name,
      type: "OTHER",
      startsAt: null,
      endsAt: null,
    },
  }));
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate total discount amount from applied pricing rules.
 * Returns absolute value of sum of negative effects.
 */
export function calculateDiscountAmount(
  appliedRules: PriceBreakdown["appliedRules"],
): number {
  return Math.abs(
    appliedRules
      .filter((rule) => rule.effect < 0)
      .reduce((sum, rule) => sum + rule.effect, 0),
  );
}

/**
 * Transform pricing module PriceBreakdown to registration storage format.
 * Maps 'extras'/'extrasTotal' to 'accessItems'/'accessTotal' and ensures
 * consistent JSONB shape across create and edit paths.
 */
export function toPersistablePriceBreakdown(
  pricingResult: PricingPriceBreakdown,
): PriceBreakdown {
  return {
    basePrice: pricingResult.basePrice,
    appliedRules: pricingResult.appliedRules,
    calculatedBasePrice: pricingResult.calculatedBasePrice,
    accessItems: pricingResult.extras.map((extra) => ({
      accessId: extra.extraId,
      name: extra.name,
      unitPrice: extra.unitPrice,
      quantity: extra.quantity,
      subtotal: extra.subtotal,
    })),
    accessTotal: pricingResult.extrasTotal,
    subtotal: pricingResult.subtotal,
    sponsorships: pricingResult.sponsorships,
    sponsorshipTotal: pricingResult.sponsorshipTotal,
    total: pricingResult.total,
    currency: pricingResult.currency,
  };
}

/**
 * Enrich a registration with accessSelections derived from priceBreakdown.
 * Fetches access details from EventAccess table and reconstructs the shape
 * that was previously provided by the RegistrationAccess relation.
 */
export async function enrichWithAccessSelections(
  registration: Registration & {
    form: { id: string; name: string };
    event: { id: string; name: string; slug: string; clientId: string };
  },
  client: { eventAccess: (typeof prisma)["eventAccess"] } = prisma,
): Promise<RegistrationWithRelations> {
  const priceBreakdown = parsePriceBreakdown(registration.priceBreakdown);

  // If no access items, return empty array
  if (!priceBreakdown.accessItems || priceBreakdown.accessItems.length === 0) {
    return { ...registration, accessSelections: [] };
  }

  // Fetch access details for display
  const accessIds = priceBreakdown.accessItems.map((item) => item.accessId);
  const accessDetails = await client.eventAccess.findMany({
    where: { id: { in: accessIds } },
    select: { id: true, name: true, type: true, startsAt: true, endsAt: true },
  });

  const accessMap = new Map(accessDetails.map((a) => [a.id, a]));

  const accessSelections = reconstructAccessSelections(
    priceBreakdown,
    accessMap,
    registration.id,
  );

  return { ...registration, accessSelections };
}

/**
 * Enrich multiple registrations with accessSelections in a single batch.
 * More efficient than calling enrichWithAccessSelections for each one.
 */
export async function enrichManyWithAccessSelections(
  registrations: Array<
    Registration & {
      form: { id: string; name: string };
      event: { id: string; name: string; slug: string; clientId: string };
    }
  >,
): Promise<RegistrationWithRelations[]> {
  // Collect all unique access IDs across all registrations
  const allAccessIds = new Set<string>();
  for (const reg of registrations) {
    const priceBreakdown = parsePriceBreakdown(reg.priceBreakdown);
    if (priceBreakdown.accessItems) {
      for (const item of priceBreakdown.accessItems) {
        allAccessIds.add(item.accessId);
      }
    }
  }

  // Fetch all access details in one query
  const accessDetails = await prisma.eventAccess.findMany({
    where: { id: { in: Array.from(allAccessIds) } },
    select: { id: true, name: true, type: true, startsAt: true, endsAt: true },
  });

  const accessMap = new Map(accessDetails.map((a) => [a.id, a]));

  // Enrich each registration
  return registrations.map((registration) => {
    const priceBreakdown = parsePriceBreakdown(registration.priceBreakdown);

    if (
      !priceBreakdown.accessItems ||
      priceBreakdown.accessItems.length === 0
    ) {
      return { ...registration, accessSelections: [] };
    }

    const accessSelections = reconstructAccessSelections(
      priceBreakdown,
      accessMap,
      registration.id,
    );

    return { ...registration, accessSelections };
  });
}
