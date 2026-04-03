import { prisma } from "@/database/client.js";
import type { PriceBreakdown } from "@pricing";
import type { Registration } from "@/generated/prisma/client.js";

// ============================================================================
// Types
// ============================================================================

type AccessSelectionItem = {
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
};

type DroppedAccessSelectionItem = AccessSelectionItem & {
  reason: string;
};

export type RegistrationWithRelations = Registration & {
  accessSelections: AccessSelectionItem[];
  droppedAccessSelections: DroppedAccessSelectionItem[];
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

  const droppedItems = priceBreakdown.droppedAccessItems ?? [];
  const hasItems = priceBreakdown.accessItems?.length > 0;
  const hasDropped = droppedItems.length > 0;

  if (!hasItems && !hasDropped) {
    return { ...registration, accessSelections: [], droppedAccessSelections: [] };
  }

  // Fetch access details for both active and dropped items
  const allAccessIds = [
    ...(priceBreakdown.accessItems ?? []).map((item) => item.accessId),
    ...droppedItems.map((item) => item.accessId),
  ];
  const accessDetails = await prisma.eventAccess.findMany({
    where: { id: { in: allAccessIds } },
    select: {
      id: true,
      name: true,
      type: true,
      startsAt: true,
      endsAt: true,
    },
  });

  const accessMap = new Map(accessDetails.map((a) => [a.id, a]));
  const fallbackAccess = (item: { accessId: string; name: unknown }) => ({
    id: item.accessId,
    name: String(item.name ?? item.accessId),
    type: "OTHER",
    startsAt: null as Date | null,
    endsAt: null as Date | null,
  });

  // Reconstruct accessSelections from priceBreakdown
  const accessSelections = (priceBreakdown.accessItems ?? []).map((item) => ({
    id: `${registration.id}-${item.accessId}`,
    accessId: item.accessId,
    unitPrice: item.unitPrice,
    quantity: item.quantity,
    subtotal: item.subtotal,
    access: accessMap.get(item.accessId) ?? fallbackAccess(item),
  }));

  // Reconstruct droppedAccessSelections
  const droppedAccessSelections = droppedItems.map((item) => ({
    id: `${registration.id}-dropped-${item.accessId}`,
    accessId: item.accessId,
    unitPrice: item.unitPrice,
    quantity: item.quantity,
    subtotal: item.subtotal,
    reason: item.reason,
    access: accessMap.get(item.accessId) ?? fallbackAccess(item),
  }));

  return { ...registration, accessSelections, droppedAccessSelections };
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
  // Collect all unique access IDs across all registrations (active + dropped)
  const allAccessIds = new Set<string>();
  for (const reg of registrations) {
    const priceBreakdown = reg.priceBreakdown as PriceBreakdown;
    if (priceBreakdown.accessItems) {
      for (const item of priceBreakdown.accessItems) {
        allAccessIds.add(item.accessId);
      }
    }
    if (priceBreakdown.droppedAccessItems) {
      for (const item of priceBreakdown.droppedAccessItems) {
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
  const fallbackAccess = (item: { accessId: string; name: unknown }) => ({
    id: item.accessId,
    name: String(item.name ?? item.accessId),
    type: "OTHER",
    startsAt: null as Date | null,
    endsAt: null as Date | null,
  });

  // Enrich each registration
  return registrations.map((registration) => {
    const priceBreakdown = registration.priceBreakdown as PriceBreakdown;

    const accessSelections = (priceBreakdown.accessItems ?? []).map((item) => ({
      id: `${registration.id}-${item.accessId}`,
      accessId: item.accessId,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      subtotal: item.subtotal,
      access: accessMap.get(item.accessId) ?? fallbackAccess(item),
    }));

    const droppedAccessSelections = (priceBreakdown.droppedAccessItems ?? []).map((item) => ({
      id: `${registration.id}-dropped-${item.accessId}`,
      accessId: item.accessId,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      subtotal: item.subtotal,
      reason: item.reason,
      access: accessMap.get(item.accessId) ?? fallbackAccess(item),
    }));

    return { ...registration, accessSelections, droppedAccessSelections };
  });
}
