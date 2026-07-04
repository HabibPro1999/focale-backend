import { evaluateConditions, type Condition } from "@app/shared";
import type { EventAccessWithPrereqIds } from "@app/db";
import type { DateGroup, GroupedAccessResponse, TimeSlot } from "@app/contracts";

type EnrichedAccess = EventAccessWithPrereqIds & {
  spotsRemaining: number | null;
  isFull: boolean;
};

function hasConditions(conditions: unknown): boolean {
  return Array.isArray(conditions) && conditions.length > 0;
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
        !evaluateConditions(
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

  const addonItems = enrichedAccess.filter((a) => a.type === "ADDON");
  const scheduledItems = enrichedAccess.filter((a) => a.type !== "ADDON");

  const formatDateLabel = (dateStr: string): string => {
    if (dateStr === "no-date") return "Sans date";
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
    const dateKey = access.startsAt
      ? localDayFormat.format(access.startsAt)
      : "no-date";
    if (!dateMap.has(dateKey)) dateMap.set(dateKey, []);
    dateMap.get(dateKey)!.push(access);
  }

  const groups: DateGroup[] = Array.from(dateMap.entries()).map(
    ([dateKey, items]) => {
      const slotMap = new Map<string, EnrichedAccess[]>();
      for (const item of items) {
        const timeKey = item.startsAt?.toISOString() || "no-time";
        if (!slotMap.has(timeKey)) slotMap.set(timeKey, []);
        slotMap.get(timeKey)!.push(item);
      }

      const slots: TimeSlot[] = Array.from(slotMap.entries())
        .map(([, slotItems]) => ({
          startsAt: slotItems[0].startsAt,
          endsAt: slotItems[0].endsAt,
          selectionType: (slotItems.length > 1 ? "single" : "multiple") as
            | "single"
            | "multiple",
          items: slotItems.sort((a, b) => {
            if (a.startsAt && b.startsAt) {
              const timeA = a.startsAt.getTime();
              const timeB = b.startsAt.getTime();
              if (timeA !== timeB) return timeA - timeB;
            }
            return a.sortOrder - b.sortOrder;
          }),
        }))
        .sort((a, b) => {
          if (!a.startsAt && !b.startsAt) return 0;
          if (!a.startsAt) return 1;
          if (!b.startsAt) return -1;
          return a.startsAt.getTime() - b.startsAt.getTime();
        });

      return { dateKey, label: formatDateLabel(dateKey), slots };
    },
  );

  groups.sort((a, b) => {
    if (a.dateKey === "no-date" && b.dateKey === "no-date") return 0;
    if (a.dateKey === "no-date") return 1;
    if (b.dateKey === "no-date") return -1;
    return new Date(a.dateKey).getTime() - new Date(b.dateKey).getTime();
  });

  return {
    groups,
    addonGroup:
      addonItems.length > 0
        ? { items: addonItems.sort((a, b) => a.sortOrder - b.sortOrder) }
        : null,
  };
}
