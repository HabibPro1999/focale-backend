import { prisma } from "@/database/client.js";
import { evaluateConditions } from "@shared/utils/conditions.js";
import type {
  GroupedAccessResponse,
  AccessCondition,
  TimeSlot,
  DateGroup,
} from "./access.schema.js";
import type { EventAccess } from "@/generated/prisma/client.js";

type EnrichedAccess = EventAccess & {
  requiredAccess: { id: string }[];
  spotsRemaining: number | null;
  isFull: boolean;
};

function hasConditions(conditions: unknown): boolean {
  return Array.isArray(conditions) && conditions.length > 0;
}

/**
 * Items sharing an exclusivity key are mutually exclusive when undated:
 * same type, and for OTHER also the same group label.
 */
export function getExclusivityKey(
  access: Pick<EventAccess, "type" | "groupLabel">,
): string {
  return access.type === "OTHER"
    ? `OTHER:${access.groupLabel ?? ""}`
    : access.type;
}

/** Display order: admin sort order first, creation order as tie-breaker. */
function byOrder(
  a: Pick<EventAccess, "sortOrder" | "createdAt">,
  b: Pick<EventAccess, "sortOrder" | "createdAt">,
): number {
  return (
    a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime()
  );
}

/**
 * Returns access items grouped hierarchically by date and time slot,
 * filtered by availability, form conditions, and prerequisites.
 *
 * Selection type hint per slot: "single" (radio) for 2+ items at same time,
 * "multiple" (checkbox) for 1 item.
 */
export async function getGroupedAccess(
  eventId: string,
  formData: Record<string, unknown>,
  selectedAccessIds: string[] = [],
): Promise<GroupedAccessResponse> {
  const allAccess = await prisma.eventAccess.findMany({
    where: { eventId, active: true },
    include: { requiredAccess: { select: { id: true } } },
    orderBy: [{ sortOrder: "asc" }, { startsAt: "asc" }, { createdAt: "asc" }],
  });

  const now = new Date();
  const selectedAccessIdSet = new Set(selectedAccessIds);

  const availableAccess = allAccess.filter((access) => {
    if (access.availableFrom && access.availableFrom > now) return false;
    if (access.availableTo && access.availableTo < now) return false;

    if (hasConditions(access.conditions)) {
      if (
        !evaluateConditions(
          access.conditions as AccessCondition[],
          access.conditionLogic as "AND" | "OR",
          formData,
        )
      ) {
        return false;
      }
    }

    if (access.requiredAccess && access.requiredAccess.length > 0) {
      const hasAllPrerequisites = access.requiredAccess.every((req) =>
        selectedAccessIdSet.has(req.id),
      );
      if (!hasAllPrerequisites) return false;
    }

    return true;
  });

  const enrichedAccess: EnrichedAccess[] = availableAccess.map((access) => {
    const spotsRemaining = access.maxCapacity
      ? access.maxCapacity - access.paidCount
      : null;

    return {
      ...access,
      spotsRemaining,
      isFull: spotsRemaining !== null && spotsRemaining <= 0,
    };
  });

  const optionItems = enrichedAccess.filter(
    (a) => a.type === "ADDON" || a.startsAt === null,
  );
  const scheduledItems = enrichedAccess.filter(
    (a) => a.type !== "ADDON" && a.startsAt !== null,
  );

  const formatDateLabel = (dateStr: string): string => {
    const date = new Date(dateStr + "T00:00:00");
    const formatted = date.toLocaleDateString("fr-FR", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
    return formatted.charAt(0).toUpperCase() + formatted.slice(1);
  };

  const dateMap = new Map<string, EnrichedAccess[]>();

  for (const access of scheduledItems) {
    const dateKey = access.startsAt!.toISOString().split("T")[0];

    if (!dateMap.has(dateKey)) dateMap.set(dateKey, []);
    dateMap.get(dateKey)!.push(access);
  }

  const groups: DateGroup[] = Array.from(dateMap.entries()).map(
    ([dateKey, items]) => {
      const slotMap = new Map<string, EnrichedAccess[]>();
      for (const item of items) {
        const timeKey = item.startsAt!.toISOString();
        if (!slotMap.has(timeKey)) slotMap.set(timeKey, []);
        slotMap.get(timeKey)!.push(item);
      }

      const slots: TimeSlot[] = Array.from(slotMap.entries())
        .map(([_timeKey, slotItems]) => toSlot(slotItems))
        .sort((a, b) => a.startsAt!.getTime() - b.startsAt!.getTime());

      return {
        dateKey,
        label: formatDateLabel(dateKey),
        slots,
      };
    },
  );

  groups.sort(
    (a, b) => new Date(a.dateKey).getTime() - new Date(b.dateKey).getTime(),
  );

  return {
    groups,
    addonGroup: buildAddonGroup(optionItems),
  };
}

/**
 * Builds the options group: undated items plus every ADDON.
 *
 * - all ADDON items share one "multiple" slot;
 * - each undated `includedInBase` non-ADDON item gets its own "multiple" slot
 *   (it can never be deselected, so it must not sit in a radio group);
 * - the remaining undated non-ADDON items are bucketed by exclusivity key and
 *   become a "single" (radio) slot when a bucket holds more than one item.
 */
function buildAddonGroup(
  optionItems: EnrichedAccess[],
): { slots: TimeSlot[] } | null {
  if (optionItems.length === 0) return null;

  const addonItems: EnrichedAccess[] = [];
  const includedItems: EnrichedAccess[] = [];
  const exclusiveBuckets = new Map<string, EnrichedAccess[]>();

  for (const item of optionItems) {
    if (item.type === "ADDON") {
      addonItems.push(item);
      continue;
    }
    if (item.includedInBase) {
      includedItems.push(item);
      continue;
    }
    const key = getExclusivityKey(item);
    if (!exclusiveBuckets.has(key)) exclusiveBuckets.set(key, []);
    exclusiveBuckets.get(key)!.push(item);
  }

  const slots: TimeSlot[] = [];

  if (addonItems.length > 0) {
    // ADDON items may carry dates but render as one undated list.
    slots.push({
      ...toSlot(addonItems, "multiple"),
      startsAt: null,
      endsAt: null,
    });
  }
  for (const item of includedItems) {
    slots.push(toSlot([item], "multiple"));
  }
  for (const bucket of exclusiveBuckets.values()) {
    slots.push(toSlot(bucket));
  }

  slots.sort((a, b) =>
    byOrder((a.items as EnrichedAccess[])[0], (b.items as EnrichedAccess[])[0]),
  );

  return { slots };
}

function toSlot(
  items: EnrichedAccess[],
  selectionType?: "single" | "multiple",
): TimeSlot {
  const sorted = [...items].sort(byOrder);
  return {
    startsAt: sorted[0].startsAt,
    endsAt: sorted[0].endsAt,
    selectionType: selectionType ?? (sorted.length > 1 ? "single" : "multiple"),
    items: sorted,
  };
}
