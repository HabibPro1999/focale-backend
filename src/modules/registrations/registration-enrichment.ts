import { prisma } from "@/database/client.js";
import type { PriceBreakdown } from "@pricing";
import type { Registration } from "@/generated/prisma/client.js";

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
      name: string;
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
// Enrichment Functions
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
 * Enrich a registration with accessSelections derived from priceBreakdown.
 * Fetches access details from EventAccess table and reconstructs the shape
 * that was previously provided by the RegistrationAccess relation.
 */
export async function enrichWithAccessSelections(
  registration: Registration & {
    form: { id: string; name: string };
    event: { id: string; name: string; slug: string; clientId: string };
  },
): Promise<RegistrationWithRelations> {
  const priceBreakdown = registration.priceBreakdown as PriceBreakdown;

  // If no access items, return empty array
  if (!priceBreakdown.accessItems || priceBreakdown.accessItems.length === 0) {
    return { ...registration, accessSelections: [] };
  }

  // Fetch access details for display
  const accessIds = priceBreakdown.accessItems.map((item) => item.accessId);
  const accessDetails = await prisma.eventAccess.findMany({
    where: { id: { in: accessIds } },
    select: {
      id: true,
      name: true,
      type: true,
      startsAt: true,
      endsAt: true,
    },
  });

  const accessMap = new Map(accessDetails.map((a) => [a.id, a]));

  // Reconstruct accessSelections from priceBreakdown
  const accessSelections = priceBreakdown.accessItems.map((item) => ({
    id: `${registration.id}-${item.accessId}`,
    accessId: item.accessId,
    unitPrice: item.unitPrice,
    quantity: item.quantity,
    subtotal: item.subtotal,
    access: accessMap.get(item.accessId) ?? {
      id: item.accessId,
      name: item.name,
      type: "OTHER",
      startsAt: null,
      endsAt: null,
    },
  }));

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
    const priceBreakdown = reg.priceBreakdown as PriceBreakdown;
    if (priceBreakdown.accessItems) {
      for (const item of priceBreakdown.accessItems) {
        allAccessIds.add(item.accessId);
      }
    }
  }

  // Fetch all access details in one query
  const accessDetails = await prisma.eventAccess.findMany({
    where: { id: { in: Array.from(allAccessIds) } },
    select: {
      id: true,
      name: true,
      type: true,
      startsAt: true,
      endsAt: true,
    },
  });

  const accessMap = new Map(accessDetails.map((a) => [a.id, a]));

  // Enrich each registration
  return registrations.map((registration) => {
    const priceBreakdown = registration.priceBreakdown as PriceBreakdown;

    if (
      !priceBreakdown.accessItems ||
      priceBreakdown.accessItems.length === 0
    ) {
      return { ...registration, accessSelections: [] };
    }

    const accessSelections = priceBreakdown.accessItems.map((item) => ({
      id: `${registration.id}-${item.accessId}`,
      accessId: item.accessId,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      subtotal: item.subtotal,
      access: accessMap.get(item.accessId) ?? {
        id: item.accessId,
        name: item.name,
        type: "OTHER",
        startsAt: null,
        endsAt: null,
      },
    }));

    return { ...registration, accessSelections };
  });
}
