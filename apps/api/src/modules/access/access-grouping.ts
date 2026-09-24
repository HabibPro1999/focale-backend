import { evaluateRuleConditions, type Condition } from "@app/shared";
import type { EventAccessWithPrereqIds } from "@app/db";
import type { DateGroup, GroupedAccessResponse, TimeSlot } from "@app/contracts";

type EnrichedAccess = EventAccessWithPrereqIds & {
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
  access: Pick<EventAccessWithPrereqIds, "type" | "groupLabel">,
): string {
  return access.type === "OTHER"
    ? `OTHER:${access.groupLabel ?? ""}`
    : access.type;
}

/** Display order: admin sort order first, creation order as tie-breaker. */
function byOrder(
  a: Pick<EventAccessWithPrereqIds, "sortOrder" | "createdAt">,
  b: Pick<EventAccessWithPrereqIds, "sortOrder" | "createdAt">,
): number {
  return (
    a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime()
  );
}

// Day buckets and their French headers must use the event's local calendar day,
// not the UTC day — otherwise a session starting within the UTC offset after
// local midnight (e.g. 00:30 in Tunisia, stored as 23:30Z the previous day)
// would be listed under the previous day's header. Events carry no timezone
// column yet; all events are Tunisia-based today.
const EVENT_TIME_ZONE = "Africa/Tunis";

// en-CA formats as YYYY-MM-DD, matching the dateKey contract.
const localDayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: EVENT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Pure grouping of active access items into date → time-slot groups, filtered by
 * availability window, form conditions, and prerequisites. Full items are NOT
 * removed — they stay in the result with `isFull` set (capacity is informational
 * here). `selectionType`: "single" (radio) for 2+ items in a slot, "multiple"
 * (checkbox) for exactly one. Callers pass already-fetched active access rows.
 */
export function groupAccess(
  allAccess: EventAccessWithPrereqIds[],
  formData: Record<string, unknown>,
  selectedAccessIds: string[],
  now: Date,
): GroupedAccessResponse {
  const selectedAccessIdSet = new Set(selectedAccessIds);

  const availableAccess = allAccess.filter((access) => {
    if (access.availableFrom && access.availableFrom > now) return false;
    if (access.availableTo && access.availableTo < now) return false;

    if (hasConditions(access.conditions)) {
      if (
        !evaluateRuleConditions(
          access.conditions as Condition[],
          access.conditionLogic,
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
    // dateKey is already the event-local calendar day; render exactly that day
    // by anchoring at UTC midnight and formatting in UTC (server-TZ-independent).
    const date = new Date(dateStr + "T00:00:00Z");
    const formatted = date.toLocaleDateString("fr-FR", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    });
    return formatted.charAt(0).toUpperCase() + formatted.slice(1);
  };

  const dateMap = new Map<string, EnrichedAccess[]>();
  for (const access of scheduledItems) {
    const dateKey = localDayFormat.format(access.startsAt!);
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

      const slots = Array.from(slotMap.values()).map((items) => toSlot(items))
        .sort((a, b) => a.startsAt!.getTime() - b.startsAt!.getTime());

      return { dateKey, label: formatDateLabel(dateKey), slots };
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
