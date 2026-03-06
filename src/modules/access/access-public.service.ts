import { prisma } from "@/database/client.js";
import { AccessConditionSchema } from "./access.schema.js";
import type { AccessSelection } from "./access.schema.js";
import type { EventAccess } from "@/generated/prisma/client.js";
import { evaluateConditions as sharedEvaluateConditions } from "@shared/utils/condition-evaluator.js";
import { logger } from "@shared/utils/logger.js";

// ============================================================================
// Types
// ============================================================================

type RawAccessItem = EventAccess & { requiredAccess: { id: string }[] };

type EnrichedAccess = EventAccess & {
  requiredAccess: { id: string }[];
  spotsRemaining: number | null;
  isFull: boolean;
};

type TimeSlot = {
  startsAt: Date | null;
  endsAt: Date | null;
  selectionType: "single" | "multiple";
  items: unknown[];
};

type DateGroup = {
  dateKey: string;
  label: string;
  slots: TimeSlot[];
};

type GroupedAccessResponse = {
  groups: DateGroup[];
};

type AccessMapItem = EventAccess & { requiredAccess: { id: string }[] };

// ============================================================================
// Filters
// ============================================================================

/**
 * Filter access items by date availability window.
 * Removes items whose availableFrom is in the future or availableTo is in the past.
 */
function filterAccessByAvailability(
  items: RawAccessItem[],
  now: Date,
): RawAccessItem[] {
  return items.filter((access) => {
    if (access.availableFrom && access.availableFrom > now) return false;
    if (access.availableTo && access.availableTo < now) return false;
    return true;
  });
}

/**
 * Filter access items by form-based conditions.
 * Removes items whose conditions evaluate to false for the given formData.
 */
function filterAccessByConditions(
  items: RawAccessItem[],
  formData: Record<string, unknown>,
): RawAccessItem[] {
  return items.filter((access) => {
    if (!access.conditions) return true;
    const conditionsResult = AccessConditionSchema.array().safeParse(
      access.conditions,
    );
    if (!conditionsResult.success) {
      logger.warn(
        { accessId: access.id, error: conditionsResult.error.message },
        "Invalid conditions JSONB for access item, skipping (filterAccessByConditions)",
      );
      return false;
    }
    return sharedEvaluateConditions(
      conditionsResult.data,
      access.conditionLogic as "and" | "or",
      formData,
    );
  });
}

/**
 * Filter access items by prerequisite satisfaction.
 * Removes items whose required access IDs are not all present in selectedAccessIds.
 */
function filterByPrerequisites(
  items: RawAccessItem[],
  selectedAccessIds: string[],
): RawAccessItem[] {
  return items.filter((access) => {
    if (!access.requiredAccess || access.requiredAccess.length === 0)
      return true;
    return access.requiredAccess.every((req) =>
      selectedAccessIds.includes(req.id),
    );
  });
}

// ============================================================================
// Hierarchical Grouping (Type → Time Slots)
// ============================================================================

/**
 * Group enriched access items into date buckets, each containing time slots.
 *
 * Structure: date → time slots → items
 * - If 2+ items share the same startsAt → selectionType: 'single' (radio)
 * - If 1 item in a time slot → selectionType: 'multiple' (checkbox)
 */
function groupAccessByDate(items: EnrichedAccess[]): DateGroup[] {
  // Format date as French day name + date (e.g., "Jeudi 16 avril")
  const formatDateLabel = (dateStr: string): string => {
    if (dateStr === "no-date") return "Sans date";
    const date = new Date(dateStr + "T00:00:00");
    const formatted = date.toLocaleDateString("fr-FR", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
    // Capitalize first letter
    return formatted.charAt(0).toUpperCase() + formatted.slice(1);
  };

  // Step 1: Group by DATE (day only, no time)
  const dateMap = new Map<string, EnrichedAccess[]>();
  for (const access of items) {
    const dateKey = access.startsAt
      ? access.startsAt.toISOString().split("T")[0]
      : "no-date";
    if (!dateMap.has(dateKey)) dateMap.set(dateKey, []);
    dateMap.get(dateKey)!.push(access);
  }

  // Step 2: For each date, sub-group by TIME SLOT
  const groups: DateGroup[] = Array.from(dateMap.entries()).map(
    ([dateKey, dateItems]) => {
      const slotMap = new Map<string, EnrichedAccess[]>();
      for (const item of dateItems) {
        const timeKey = item.startsAt?.toISOString() || "no-time";
        if (!slotMap.has(timeKey)) slotMap.set(timeKey, []);
        slotMap.get(timeKey)!.push(item);
      }

      const slots: TimeSlot[] = Array.from(slotMap.entries())
        .map(([_timeKey, slotItems]) => ({
          startsAt: slotItems[0].startsAt,
          endsAt: slotItems[0].endsAt,
          // 2+ items at same time = single (radio), 1 item = multiple (checkbox)
          selectionType: (slotItems.length > 1 ? "single" : "multiple") as
            | "single"
            | "multiple",
          items: slotItems.sort((a, b) => a.sortOrder - b.sortOrder),
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

  // Sort groups chronologically; "no-date" items go to the end
  groups.sort((a, b) => {
    if (a.dateKey === "no-date" && b.dateKey === "no-date") return 0;
    if (a.dateKey === "no-date") return 1;
    if (b.dateKey === "no-date") return -1;
    return new Date(a.dateKey).getTime() - new Date(b.dateKey).getTime();
  });

  return groups;
}

/**
 * Get access items grouped hierarchically: DATE → TIME SLOTS
 *
 * Structure:
 * - Groups are organized by date day
 * - Within each date, items are sub-grouped by time slot (startsAt)
 * - If 2+ items share the same time slot → selectionType: 'single' (radio)
 * - If 1 item in a time slot → selectionType: 'multiple' (checkbox)
 *
 * This allows users to select one item from each parallel time slot
 * (e.g., pick one of 3 workshops at 12:00, AND one of 2 workshops at 14:00)
 */
export async function getGroupedAccess(
  eventId: string,
  formData: Record<string, unknown>,
  selectedAccessIds: string[] = [],
): Promise<GroupedAccessResponse> {
  const allAccess = await prisma.eventAccess.findMany({
    where: { eventId, active: true },
    include: { requiredAccess: { select: { id: true } } },
    orderBy: [{ type: "asc" }, { sortOrder: "asc" }, { startsAt: "asc" }],
  });

  const now = new Date();

  // Filter by availability, conditions, and prerequisites
  const availableAccess = filterByPrerequisites(
    filterAccessByConditions(
      filterAccessByAvailability(allAccess, now),
      formData,
    ),
    selectedAccessIds,
  );

  // Enrich with capacity info
  const enrichedAccess: EnrichedAccess[] = availableAccess.map((access) => {
    const spotsRemaining = access.maxCapacity
      ? access.maxCapacity - access.registeredCount
      : null;
    return {
      ...access,
      spotsRemaining,
      isFull: spotsRemaining !== null && spotsRemaining <= 0,
    };
  });

  return { groups: groupAccessByDate(enrichedAccess) };
}

// ============================================================================
// Selection Validation
// ============================================================================

function checkTimeConflicts(
  selections: AccessSelection[],
  accessMap: Map<string, AccessMapItem>,
): string[] {
  const errors: string[] = [];
  const selectionsByType = new Map<
    string,
    { access: EventAccess; selection: AccessSelection }[]
  >();

  for (const selection of selections) {
    const access = accessMap.get(selection.accessId)!;
    const typeKey =
      access.type === "OTHER"
        ? `OTHER:${access.groupLabel || access.id}`
        : access.type;

    if (!selectionsByType.has(typeKey)) selectionsByType.set(typeKey, []);
    selectionsByType.get(typeKey)!.push({ access, selection });
  }

  for (const typeItems of selectionsByType.values()) {
    for (let i = 0; i < typeItems.length; i++) {
      for (let j = i + 1; j < typeItems.length; j++) {
        const a = typeItems[i].access;
        const b = typeItems[j].access;

        if (a.startsAt && a.endsAt && b.startsAt && b.endsAt) {
          const aStart = a.startsAt.getTime();
          const aEnd = a.endsAt.getTime();
          const bStart = b.startsAt.getTime();
          const bEnd = b.endsAt.getTime();

          if (!(aEnd <= bStart || bEnd <= aStart)) {
            errors.push(`Time conflict: "${a.name}" and "${b.name}" overlap`);
          }
        }
      }
    }
  }

  return errors;
}

function validateAccessPrerequisites(
  selections: AccessSelection[],
  accessMap: Map<string, AccessMapItem>,
): string[] {
  const errors: string[] = [];
  const accessIds = selections.map((s) => s.accessId);

  for (const selection of selections) {
    const access = accessMap.get(selection.accessId)!;
    if (access.requiredAccess && access.requiredAccess.length > 0) {
      for (const req of access.requiredAccess) {
        if (!accessIds.includes(req.id)) {
          errors.push(
            `${access.name} requires selecting its prerequisite first`,
          );
        }
      }
    }
  }

  return errors;
}

function validateFormConditions(
  selections: AccessSelection[],
  accessMap: Map<string, AccessMapItem>,
  formData: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  const now = new Date();

  for (const selection of selections) {
    const access = accessMap.get(selection.accessId)!;

    if (access.availableFrom && access.availableFrom > now) {
      errors.push(`${access.name} is not yet available`);
    }
    if (access.availableTo && access.availableTo < now) {
      errors.push(`${access.name} is no longer available`);
    }

    if (access.conditions) {
      const conditionsParseResult = AccessConditionSchema.array().safeParse(
        access.conditions,
      );
      if (!conditionsParseResult.success) {
        logger.warn(
          { accessId: access.id, error: conditionsParseResult.error.message },
          "Invalid conditions JSONB for access item, skipping condition check",
        );
        errors.push(`${access.name} has invalid configuration`);
        continue;
      }
      const conditions = conditionsParseResult.data;
      if (
        conditions.length > 0 &&
        !sharedEvaluateConditions(
          conditions,
          access.conditionLogic as "and" | "or",
          formData,
        )
      ) {
        errors.push(
          `${access.name} is not available based on your form answers`,
        );
      }
    }
  }

  return errors;
}

/**
 * Validate access selections for a registration.
 * Checks: time conflicts, prerequisites, capacity.
 */
export async function validateAccessSelections(
  eventId: string,
  selections: AccessSelection[],
  formData: Record<string, unknown>,
): Promise<{ valid: boolean; errors: string[] }> {
  if (selections.length === 0) {
    return { valid: true, errors: [] };
  }

  const accessIds = selections.map((s) => s.accessId);
  const accessItems = await prisma.eventAccess.findMany({
    where: { id: { in: accessIds }, eventId, active: true },
    include: { requiredAccess: { select: { id: true } } },
  });

  const accessMap = new Map(accessItems.map((a) => [a.id, a]));

  // Check all selected items exist
  const existenceErrors: string[] = [];
  for (const selection of selections) {
    if (!accessMap.has(selection.accessId)) {
      existenceErrors.push(
        `Access item ${selection.accessId} not found or inactive`,
      );
    }
  }
  if (existenceErrors.length > 0) return { valid: false, errors: existenceErrors };

  // Validate companion quantity
  const companionErrors: string[] = [];
  for (const selection of selections) {
    const access = accessMap.get(selection.accessId)!;
    if (selection.quantity > 1 && !access.allowCompanion) {
      companionErrors.push(
        `${access.name} does not allow companion (quantity must be 1)`,
      );
    }
    if (selection.quantity > 2 && access.allowCompanion) {
      companionErrors.push(
        `${access.name} allows maximum quantity of 2 with companion`,
      );
    }
  }

  const timeErrors = checkTimeConflicts(selections, accessMap);
  const prereqErrors = validateAccessPrerequisites(selections, accessMap);
  const conditionErrors = validateFormConditions(selections, accessMap, formData);

  // Check capacity (without reserving)
  const capacityErrors: string[] = [];
  for (const selection of selections) {
    const access = accessMap.get(selection.accessId)!;
    if (access.maxCapacity !== null) {
      const spotsRemaining = access.maxCapacity - access.registeredCount;
      if (spotsRemaining < selection.quantity) {
        capacityErrors.push(`${access.name} is full`);
      }
    }
  }

  const errors = [
    ...companionErrors,
    ...timeErrors,
    ...prereqErrors,
    ...conditionErrors,
    ...capacityErrors,
  ];

  return { valid: errors.length === 0, errors };
}
