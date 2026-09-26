import type { PriceBreakdown } from "@app/contracts";
import {
  findAccessDetailsByIds,
  type AccessDisplayDetail,
  type RegistrationWithMeta,
  type DbExecutor,
} from "@app/db";

// ============================================================================
// Enriched response shape (legacy RegistrationWithRelations)
// ============================================================================

export interface AccessSelectionItem {
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
}

export type DroppedAccessSelectionItem = AccessSelectionItem & {
  reason: string;
};

/** Minimal shape the enrichment reads. */
type EnrichableRegistration = { id: string; priceBreakdown: PriceBreakdown };

export type WithAccessSelections<T> = T & {
  accessSelections: AccessSelectionItem[];
  droppedAccessSelections: DroppedAccessSelectionItem[];
};

export type RegistrationWithRelations = WithAccessSelections<RegistrationWithMeta>;

function fallbackAccess(item: { accessId: string; name: unknown }) {
  return {
    id: item.accessId,
    name: String(item.name ?? item.accessId),
    type: "OTHER",
    startsAt: null as Date | null,
    endsAt: null as Date | null,
  };
}

function buildSelections(
  registration: EnrichableRegistration,
  accessMap: Map<string, AccessDisplayDetail>,
): { accessSelections: AccessSelectionItem[]; droppedAccessSelections: DroppedAccessSelectionItem[] } {
  const { priceBreakdown } = registration;
  const accessSelections = (priceBreakdown.accessItems ?? []).map((item) => ({
    id: `${registration.id}-${item.accessId}`,
    accessId: item.accessId,
    unitPrice: item.unitPrice,
    quantity: item.quantity,
    subtotal: item.subtotal,
    access: accessMap.get(item.accessId) ?? fallbackAccess(item),
  }));
  const droppedAccessSelections = (priceBreakdown.droppedAccessItems ?? []).map(
    (item) => ({
      id: `${registration.id}-dropped-${item.accessId}`,
      accessId: item.accessId,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      subtotal: item.subtotal,
      // A stored breakdown read under JSONB_VALIDATION=warn may lack the reason.
      reason: item.reason ?? "capacity_reached",
      access: accessMap.get(item.accessId) ?? fallbackAccess(item),
    }),
  );
  return { accessSelections, droppedAccessSelections };
}

/**
 * Enrich one registration with accessSelections derived PURELY from the stored
 * priceBreakdown JSON, joined against live EventAccess for display metadata.
 * Zero extra queries when the breakdown has neither active nor dropped items.
 */
export async function enrichWithAccessSelections<T extends EnrichableRegistration>(
  registration: T,
  db?: DbExecutor,
): Promise<WithAccessSelections<T>> {
  const { priceBreakdown } = registration;
  const dropped = priceBreakdown.droppedAccessItems ?? [];
  const hasItems = (priceBreakdown.accessItems?.length ?? 0) > 0;
  if (!hasItems && dropped.length === 0) {
    return { ...registration, accessSelections: [], droppedAccessSelections: [] };
  }
  const ids = [
    ...(priceBreakdown.accessItems ?? []).map((i) => i.accessId),
    ...dropped.map((i) => i.accessId),
  ];
  const details = await findAccessDetailsByIds(ids, db);
  const accessMap = new Map(details.map((a) => [a.id, a]));
  return { ...registration, ...buildSelections(registration, accessMap) };
}

/** Batched enrichment — a single EventAccess fetch across all registrations. */
export async function enrichManyWithAccessSelections<T extends EnrichableRegistration>(
  registrations: T[],
  db?: DbExecutor,
): Promise<WithAccessSelections<T>[]> {
  const ids = new Set<string>();
  for (const reg of registrations) {
    const pb = reg.priceBreakdown;
    for (const item of pb.accessItems ?? []) ids.add(item.accessId);
    for (const item of pb.droppedAccessItems ?? []) ids.add(item.accessId);
  }
  const details = await findAccessDetailsByIds([...ids], db);
  const accessMap = new Map(details.map((a) => [a.id, a]));
  return registrations.map((registration) => ({
    ...registration,
    ...buildSelections(registration, accessMap),
  }));
}
