import { randomUUID } from "crypto";
import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import type {
  CreateEventAccessInput,
  UpdateEventAccessInput,
  AccessSelection,
  GroupedAccessResponse,
  AccessCondition,
  TimeSlot,
  DateGroup,
} from "./access.schema.js";
import { Prisma } from "@/generated/prisma/client.js";
import type { EventAccess } from "@/generated/prisma/client.js";

// ============================================================================
// Types
// ============================================================================

// Transaction client type that works with Prisma extensions
type TransactionClient = { $executeRaw: typeof prisma.$executeRaw };

type EventAccessWithPrerequisites = EventAccess & {
  requiredAccess: { id: string; name: string }[];
};

type EnrichedAccess = EventAccess & {
  requiredAccess: { id: string }[];
  spotsRemaining: number | null;
  isFull: boolean;
};

// ============================================================================
// Date Boundary Validation
// ============================================================================

interface DateValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates that access item dates fall within the event's date boundaries.
 * Checks startsAt, endsAt, availableFrom, and availableTo against event dates.
 */
function validateAccessDatesAgainstEvent(
  accessDates: {
    startsAt?: Date | null;
    endsAt?: Date | null;
    availableFrom?: Date | null;
    availableTo?: Date | null;
  },
  eventDates: { startDate: Date; endDate: Date },
): DateValidationResult {
  const errors: string[] = [];
  const { startDate, endDate } = eventDates;

  const formatDate = (d: Date) =>
    d.toLocaleDateString("fr-FR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  const range = `${formatDate(startDate)} - ${formatDate(endDate)}`;

  if (
    accessDates.startsAt &&
    (accessDates.startsAt < startDate || accessDates.startsAt > endDate)
  ) {
    errors.push(
      `L'heure de début doit être dans la plage de l'événement (${range})`,
    );
  }
  if (
    accessDates.endsAt &&
    (accessDates.endsAt < startDate || accessDates.endsAt > endDate)
  ) {
    errors.push(
      `L'heure de fin doit être dans la plage de l'événement (${range})`,
    );
  }
  if (
    accessDates.availableFrom &&
    (accessDates.availableFrom < startDate ||
      accessDates.availableFrom > endDate)
  ) {
    errors.push(
      `La date de disponibilité doit être dans la plage de l'événement (${range})`,
    );
  }
  if (
    accessDates.availableTo &&
    (accessDates.availableTo < startDate || accessDates.availableTo > endDate)
  ) {
    errors.push(
      `La date limite doit être dans la plage de l'événement (${range})`,
    );
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================================
// Circular Prerequisite Detection (DFS)
// ============================================================================

/**
 * Detects circular dependencies in access prerequisites using DFS.
 * Checks for transitive cycles (A->B->C->A), not just direct self-reference.
 */
async function detectCircularPrerequisites(
  eventId: string,
  accessId: string,
  newRequiredIds: string[],
): Promise<boolean> {
  // Fetch all access items for the event with their prerequisites
  const allAccess = await prisma.eventAccess.findMany({
    where: { eventId },
    select: { id: true, requiredAccess: { select: { id: true } } },
  });

  // Build adjacency list with proposed new edges
  const graph = new Map<string, string[]>();
  for (const access of allAccess) {
    // Use new prerequisites for the item being updated, existing for others
    const deps =
      access.id === accessId
        ? newRequiredIds
        : access.requiredAccess.map((r) => r.id);
    graph.set(access.id, deps);
  }

  // Also add the node if it's a new access item not yet in the database
  if (!graph.has(accessId)) {
    graph.set(accessId, newRequiredIds);
  }

  // DFS cycle detection with recursion stack
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function hasCycle(nodeId: string): boolean {
    // If node is already in current recursion stack, cycle detected
    if (inStack.has(nodeId)) return true;
    // If already fully processed, no cycle through this path
    if (visited.has(nodeId)) return false;

    visited.add(nodeId);
    inStack.add(nodeId);

    // Check all dependencies
    for (const depId of graph.get(nodeId) ?? []) {
      if (hasCycle(depId)) return true;
    }

    // Remove from stack when backtracking
    inStack.delete(nodeId);
    return false;
  }

  // Start DFS from the access item being updated
  return hasCycle(accessId);
}

// ============================================================================
// CRUD Operations
// ============================================================================

export async function createEventAccess(
  input: CreateEventAccessInput,
): Promise<EventAccessWithPrerequisites> {
  const { eventId, requiredAccessIds, ...data } = input;

  // Fetch event for existence check and date validation
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, startDate: true, endDate: true },
  });
  if (!event) {
    throw new AppError("Event not found", 404, true, ErrorCodes.NOT_FOUND);
  }

  // Validate access dates against event boundaries
  const dateValidation = validateAccessDatesAgainstEvent(
    {
      startsAt: data.startsAt,
      endsAt: data.endsAt,
      availableFrom: data.availableFrom,
      availableTo: data.availableTo,
    },
    { startDate: event.startDate, endDate: event.endDate },
  );
  if (!dateValidation.valid) {
    throw new AppError(
      dateValidation.errors.join("; "),
      400,
      true,
      ErrorCodes.ACCESS_DATE_OUT_OF_BOUNDS,
    );
  }

  // Validate prerequisite access items exist and belong to same event
  if (requiredAccessIds && requiredAccessIds.length > 0) {
    const prerequisites = await prisma.eventAccess.findMany({
      where: { id: { in: requiredAccessIds }, eventId },
    });
    if (prerequisites.length !== requiredAccessIds.length) {
      throw new AppError(
        "One or more prerequisite access items not found or belong to different event",
        400,
        true,
        ErrorCodes.BAD_REQUEST,
      );
    }

    // Check for circular dependencies
    // For new items, generate a temporary ID for the graph check
    const tempId = randomUUID();
    const hasCycle = await detectCircularPrerequisites(
      eventId,
      tempId,
      requiredAccessIds,
    );
    if (hasCycle) {
      throw new AppError(
        "Circular prerequisite dependency detected",
        400,
        true,
        ErrorCodes.ACCESS_CIRCULAR_DEPENDENCY,
      );
    }
  }

  return prisma.eventAccess.create({
    data: {
      eventId,
      type: data.type ?? "OTHER",
      name: data.name,
      description: data.description ?? null,
      location: data.location ?? null,
      startsAt: data.startsAt ?? null,
      endsAt: data.endsAt ?? null,
      price: data.price ?? 0,
      currency: data.currency ?? "TND",
      maxCapacity: data.maxCapacity ?? null,
      availableFrom: data.availableFrom ?? null,
      availableTo: data.availableTo ?? null,
      conditions: data.conditions
        ? (data.conditions as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      conditionLogic: data.conditionLogic ?? "AND",
      sortOrder: data.sortOrder ?? 0,
      active: data.active ?? true,
      groupLabel: data.groupLabel ?? null,
      requiredAccess: requiredAccessIds?.length
        ? { connect: requiredAccessIds.map((id) => ({ id })) }
        : undefined,
    },
    include: { requiredAccess: { select: { id: true, name: true } } },
  });
}

export async function updateEventAccess(
  id: string,
  input: UpdateEventAccessInput,
): Promise<EventAccessWithPrerequisites> {
  const access = await prisma.eventAccess.findUnique({
    where: { id },
    include: {
      requiredAccess: true,
      event: { select: { startDate: true, endDate: true } },
    },
  });
  if (!access) {
    throw new AppError(
      "Access item not found",
      404,
      true,
      ErrorCodes.ACCESS_NOT_FOUND,
    );
  }

  const { requiredAccessIds, ...data } = input;

  // Merge existing dates with updates for validation
  const mergedDates = {
    startsAt: data.startsAt !== undefined ? data.startsAt : access.startsAt,
    endsAt: data.endsAt !== undefined ? data.endsAt : access.endsAt,
    availableFrom:
      data.availableFrom !== undefined
        ? data.availableFrom
        : access.availableFrom,
    availableTo:
      data.availableTo !== undefined ? data.availableTo : access.availableTo,
  };

  // Validate dates against event boundaries
  const dateValidation = validateAccessDatesAgainstEvent(mergedDates, {
    startDate: access.event.startDate,
    endDate: access.event.endDate,
  });
  if (!dateValidation.valid) {
    throw new AppError(
      dateValidation.errors.join("; "),
      400,
      true,
      ErrorCodes.ACCESS_DATE_OUT_OF_BOUNDS,
    );
  }

  // Build update data
  const updateData: Prisma.EventAccessUpdateInput = {};

  if (data.type !== undefined) updateData.type = data.type;
  if (data.name !== undefined) updateData.name = data.name;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.location !== undefined) updateData.location = data.location;
  if (data.startsAt !== undefined) updateData.startsAt = data.startsAt;
  if (data.endsAt !== undefined) updateData.endsAt = data.endsAt;
  if (data.price !== undefined) updateData.price = data.price;
  if (data.currency !== undefined) updateData.currency = data.currency;
  if (data.maxCapacity !== undefined) updateData.maxCapacity = data.maxCapacity;
  if (data.availableFrom !== undefined)
    updateData.availableFrom = data.availableFrom;
  if (data.availableTo !== undefined) updateData.availableTo = data.availableTo;
  if (data.conditions !== undefined) {
    updateData.conditions =
      data.conditions === null
        ? Prisma.JsonNull
        : (data.conditions as Prisma.InputJsonValue);
  }
  if (data.conditionLogic !== undefined)
    updateData.conditionLogic = data.conditionLogic;
  if (data.sortOrder !== undefined) updateData.sortOrder = data.sortOrder;
  if (data.active !== undefined) updateData.active = data.active;
  if (data.groupLabel !== undefined) updateData.groupLabel = data.groupLabel;

  // Handle prerequisites update
  if (requiredAccessIds !== undefined) {
    // Validate new prerequisites
    if (requiredAccessIds.length > 0) {
      const prerequisites = await prisma.eventAccess.findMany({
        where: { id: { in: requiredAccessIds }, eventId: access.eventId },
      });
      if (prerequisites.length !== requiredAccessIds.length) {
        throw new AppError(
          "One or more prerequisite access items not found",
          400,
          true,
          ErrorCodes.BAD_REQUEST,
        );
      }
      // Prevent circular dependencies (transitive check)
      const hasCycle = await detectCircularPrerequisites(
        access.eventId,
        id,
        requiredAccessIds,
      );
      if (hasCycle) {
        throw new AppError(
          "Circular prerequisite dependency detected",
          400,
          true,
          ErrorCodes.ACCESS_CIRCULAR_DEPENDENCY,
        );
      }
    }

    updateData.requiredAccess = {
      set: requiredAccessIds.map((reqId) => ({ id: reqId })),
    };
  }

  return prisma.eventAccess.update({
    where: { id },
    data: updateData,
    include: { requiredAccess: { select: { id: true, name: true } } },
  });
}

export async function deleteEventAccess(id: string): Promise<void> {
  const access = await prisma.eventAccess.findUnique({ where: { id } });
  if (!access) {
    throw new AppError(
      "Access item not found",
      404,
      true,
      ErrorCodes.ACCESS_NOT_FOUND,
    );
  }

  // Check if any registrations have selected this access
  const registrationCount = await prisma.registration.count({
    where: { accessTypeIds: { has: id } },
  });
  if (registrationCount > 0) {
    throw new AppError(
      "Cannot delete access item with existing registrations",
      409,
      true,
      ErrorCodes.ACCESS_HAS_REGISTRATIONS,
    );
  }

  await prisma.eventAccess.delete({ where: { id } });
}

export async function listEventAccess(
  eventId: string,
  options?: { active?: boolean; type?: string },
): Promise<EventAccessWithPrerequisites[]> {
  const where: Prisma.EventAccessWhereInput = { eventId };
  if (options?.active !== undefined) where.active = options.active;
  if (options?.type)
    where.type = options.type as Prisma.EnumAccessTypeFilter["equals"];

  return prisma.eventAccess.findMany({
    where,
    include: { requiredAccess: { select: { id: true, name: true } } },
    orderBy: [{ sortOrder: "asc" }, { startsAt: "asc" }, { createdAt: "asc" }],
  });
}

export async function getEventAccessById(
  id: string,
): Promise<EventAccessWithPrerequisites | null> {
  return prisma.eventAccess.findUnique({
    where: { id },
    include: { requiredAccess: { select: { id: true, name: true } } },
  });
}

export async function getAccessClientId(id: string): Promise<string | null> {
  const access = await prisma.eventAccess.findUnique({
    where: { id },
    include: { event: { select: { clientId: true } } },
  });
  return access?.event.clientId ?? null;
}

// ============================================================================
// Hierarchical Grouping (Type → Time Slots)
// ============================================================================

/**
 * Get access items grouped hierarchically: TYPE → TIME SLOTS
 *
 * Structure:
 * - Groups are organized by type (WORKSHOP, DINNER, etc.)
 * - Within each type, items are sub-grouped by time slot (startsAt)
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
  const availableAccess = allAccess.filter((access) => {
    // Check date availability
    if (access.availableFrom && access.availableFrom > now) return false;
    if (access.availableTo && access.availableTo < now) return false;

    // Check form-based conditions
    if (access.conditions) {
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

    // Check access-based prerequisites
    if (access.requiredAccess && access.requiredAccess.length > 0) {
      const hasAllPrerequisites = access.requiredAccess.every((req) =>
        selectedAccessIds.includes(req.id),
      );
      if (!hasAllPrerequisites) return false;
    }

    return true;
  });

  // Enrich with availability info
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

  // === Hierarchical grouping by DATE ===

  // Helper: Format date as French day name + date (e.g., "Jeudi 16 avril")
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

  for (const access of enrichedAccess) {
    // Extract date part only (YYYY-MM-DD)
    const dateKey = access.startsAt
      ? access.startsAt.toISOString().split("T")[0]
      : "no-date";

    if (!dateMap.has(dateKey)) dateMap.set(dateKey, []);
    dateMap.get(dateKey)!.push(access);
  }

  // Step 2: For each date, sub-group by TIME SLOT
  const groups: DateGroup[] = Array.from(dateMap.entries()).map(
    ([dateKey, items]) => {
      // Sub-group by startsAt time (full ISO string)
      const slotMap = new Map<string, EnrichedAccess[]>();
      for (const item of items) {
        const timeKey = item.startsAt?.toISOString() || "no-time";
        if (!slotMap.has(timeKey)) slotMap.set(timeKey, []);
        slotMap.get(timeKey)!.push(item);
      }

      // Convert to slots array
      const slots: TimeSlot[] = Array.from(slotMap.entries())
        .map(([_timeKey, slotItems]) => ({
          startsAt: slotItems[0].startsAt,
          endsAt: slotItems[0].endsAt,
          // 2+ items at same time = single (radio), 1 item = multiple (checkbox)
          selectionType: (slotItems.length > 1 ? "single" : "multiple") as
            | "single"
            | "multiple",
          items: slotItems.sort((a, b) => {
            // Sort by time within the slot
            if (a.startsAt && b.startsAt) {
              const timeA = a.startsAt.getTime();
              const timeB = b.startsAt.getTime();
              if (timeA !== timeB) return timeA - timeB;
            }
            // Then by sortOrder
            return a.sortOrder - b.sortOrder;
          }),
        }))
        .sort((a, b) => {
          // Sort slots by time (null times at end)
          if (!a.startsAt && !b.startsAt) return 0;
          if (!a.startsAt) return 1;
          if (!b.startsAt) return -1;
          return a.startsAt.getTime() - b.startsAt.getTime();
        });

      return {
        dateKey,
        label: formatDateLabel(dateKey),
        slots,
      };
    },
  );

  // Sort groups chronologically by date
  groups.sort((a, b) => {
    // "no-date" items go to the end
    if (a.dateKey === "no-date" && b.dateKey === "no-date") return 0;
    if (a.dateKey === "no-date") return 1;
    if (b.dateKey === "no-date") return -1;
    // Sort by date chronologically
    return new Date(a.dateKey).getTime() - new Date(b.dateKey).getTime();
  });

  return { groups };
}

// ============================================================================
// Capacity Management
// ============================================================================

/**
 * Reserve access spot with atomic capacity check.
 * Uses raw SQL with atomic WHERE clause to prevent race conditions.
 * The capacity check is performed at the time of update, not using stale values.
 * @param accessId - The access item ID
 * @param quantity - Number of spots to reserve (default 1)
 * @param tx - Optional transaction client. If provided, runs within that transaction.
 */
export async function reserveAccessSpot(
  accessId: string,
  quantity: number = 1,
  tx?: TransactionClient,
): Promise<void> {
  // Use raw SQL for truly atomic capacity check and update
  // This ensures the check happens at the exact moment of update,
  // preventing TOCTOU race conditions
  const updateResult = await (tx ?? prisma).$executeRaw`
    UPDATE event_access
    SET registered_count = registered_count + ${quantity}
    WHERE id = ${accessId}
    AND (max_capacity IS NULL OR max_capacity - registered_count >= ${quantity})
  `;

  if (updateResult === 0) {
    // Either access not found or capacity exceeded - determine which
    const access = await prisma.eventAccess.findUnique({
      where: { id: accessId },
      select: { name: true, maxCapacity: true, registeredCount: true },
    });

    if (!access) {
      throw new AppError(
        "Access not found",
        404,
        true,
        ErrorCodes.ACCESS_NOT_FOUND,
      );
    }

    const remaining = (access.maxCapacity ?? Infinity) - access.registeredCount;
    throw new AppError(
      `${access.name} has insufficient capacity (${remaining} spots remaining, requested ${quantity})`,
      409,
      true,
      ErrorCodes.ACCESS_CAPACITY_EXCEEDED,
    );
  }
}

/**
 * Release access spot with floor constraint to prevent negative counts.
 * @param accessId - The access item ID
 * @param quantity - Number of spots to release (default 1)
 * @param tx - Optional transaction client. If provided, runs within that transaction.
 */
export async function releaseAccessSpot(
  accessId: string,
  quantity: number = 1,
  tx?: TransactionClient,
): Promise<void> {
  await (tx ?? prisma).$executeRaw`
    UPDATE event_access
    SET registered_count = GREATEST(0, registered_count - ${quantity})
    WHERE id = ${accessId}
  `;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate access selections for a registration.
 * Checks: time conflicts, prerequisites, capacity.
 */
export async function validateAccessSelections(
  eventId: string,
  selections: AccessSelection[],
  formData: Record<string, unknown>,
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

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
  for (const selection of selections) {
    if (!accessMap.has(selection.accessId)) {
      errors.push(`Access item ${selection.accessId} not found or inactive`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Validate companion quantity
  for (const selection of selections) {
    const access = accessMap.get(selection.accessId)!;
    if (selection.quantity > 1 && !access.allowCompanion) {
      errors.push(
        `${access.name} does not allow companion (quantity must be 1)`,
      );
    }
    if (selection.quantity > 2 && access.allowCompanion) {
      errors.push(`${access.name} allows maximum quantity of 2 with companion`);
    }
  }

  // Check time conflicts WITHIN EACH TYPE (items with same startsAt in same type)
  // Group selections by type first, then check time slots within each type
  const selectionsByType = new Map<
    string,
    { access: EventAccess; selection: AccessSelection }[]
  >();

  for (const selection of selections) {
    const access = accessMap.get(selection.accessId)!;
    // For OTHER type, use groupLabel as key to allow custom groups
    const typeKey =
      access.type === "OTHER"
        ? `OTHER:${access.groupLabel || ""}`
        : access.type;

    if (!selectionsByType.has(typeKey)) selectionsByType.set(typeKey, []);
    selectionsByType.get(typeKey)!.push({ access, selection });
  }

  // For each type group, check for actual time OVERLAP (not just same startsAt)
  for (const typeItems of selectionsByType.values()) {
    // Compare each pair for actual time overlap
    for (let i = 0; i < typeItems.length; i++) {
      for (let j = i + 1; j < typeItems.length; j++) {
        const a = typeItems[i].access;
        const b = typeItems[j].access;

        // Only check overlap if both items have start and end times
        if (a.startsAt && a.endsAt && b.startsAt && b.endsAt) {
          const aStart = a.startsAt.getTime();
          const aEnd = a.endsAt.getTime();
          const bStart = b.startsAt.getTime();
          const bEnd = b.endsAt.getTime();

          // True overlap: !(aEnd <= bStart || bEnd <= aStart)
          // i.e., they overlap if a doesn't end before b starts AND b doesn't end before a starts
          if (!(aEnd <= bStart || bEnd <= aStart)) {
            errors.push(`Time conflict: "${a.name}" and "${b.name}" overlap`);
          }
        }
      }
    }
  }

  // Check prerequisites
  for (const selection of selections) {
    const access = accessMap.get(selection.accessId)!;
    if (access.requiredAccess && access.requiredAccess.length > 0) {
      for (const req of access.requiredAccess) {
        if (!accessIds.includes(req.id)) {
          const accessName = access.name;
          errors.push(
            `${accessName} requires selecting its prerequisite first`,
          );
        }
      }
    }
  }

  // Check form-based conditions
  const now = new Date();
  for (const selection of selections) {
    const access = accessMap.get(selection.accessId)!;

    // Date availability
    if (access.availableFrom && access.availableFrom > now) {
      errors.push(`${access.name} is not yet available`);
    }
    if (access.availableTo && access.availableTo < now) {
      errors.push(`${access.name} is no longer available`);
    }

    // Form conditions
    if (access.conditions) {
      if (
        !evaluateConditions(
          access.conditions as AccessCondition[],
          access.conditionLogic as "AND" | "OR",
          formData,
        )
      ) {
        errors.push(
          `${access.name} is not available based on your form answers`,
        );
      }
    }
  }

  // Check capacity (without reserving)
  for (const selection of selections) {
    const access = accessMap.get(selection.accessId)!;
    if (access.maxCapacity !== null) {
      const spotsRemaining = access.maxCapacity - access.registeredCount;
      if (spotsRemaining < selection.quantity) {
        errors.push(`${access.name} is full`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================================
// Helpers
// ============================================================================

function evaluateConditions(
  conditions: AccessCondition[],
  logic: "AND" | "OR",
  formData: Record<string, unknown>,
): boolean {
  const results = conditions.map((c) => evaluateSingleCondition(c, formData));
  return logic === "AND" ? results.every(Boolean) : results.some(Boolean);
}

function evaluateSingleCondition(
  condition: AccessCondition,
  formData: Record<string, unknown>,
): boolean {
  const value = formData[condition.fieldId];

  switch (condition.operator) {
    case "equals":
      return value === condition.value;
    case "not_equals":
      return value !== condition.value;
    default:
      return false;
  }
}
