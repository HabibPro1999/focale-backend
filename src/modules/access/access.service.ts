import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { logger } from "@shared/utils/logger.js";
import type { TxClient } from "@shared/types/prisma.js";
import type {
  CreateEventAccessInput,
  UpdateEventAccessInput,
} from "./access.schema.js";
import { Prisma } from "@/generated/prisma/client.js";
import type { EventAccess } from "@/generated/prisma/client.js";

// ============================================================================
// Types
// ============================================================================

type EventAccessWithPrerequisites = EventAccess & {
  requiredAccess: { id: string; name: string }[];
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
  const { startDate } = eventDates;

  // Extend endDate to 23:59:59.999 UTC so that any time on the last event day is valid
  const endDate = new Date(eventDates.endDate);
  endDate.setUTCHours(23, 59, 59, 999);

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
    throw new AppError("Event not found", 404, ErrorCodes.NOT_FOUND);
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
        ErrorCodes.BAD_REQUEST,
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
      allowCompanion: data.allowCompanion ?? false,
      includedInBase: data.includedInBase ?? false,
      companionPrice: data.companionPrice ?? 0,
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
  if (data.allowCompanion !== undefined)
    updateData.allowCompanion = data.allowCompanion;
  if (data.includedInBase !== undefined)
    updateData.includedInBase = data.includedInBase;
  if (data.companionPrice !== undefined)
    updateData.companionPrice = data.companionPrice;

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
      ErrorCodes.ACCESS_HAS_REGISTRATIONS,
    );
  }

  // Check if any active sponsorships cover this access item.
  // Deleting without this check would leave dangling IDs in coveredAccessIds,
  // silently breaking sponsorship coverage calculations.
  const sponsorshipCount = await prisma.sponsorship.count({
    where: {
      coveredAccessIds: { has: id },
      status: { not: "CANCELLED" },
    },
  });
  if (sponsorshipCount > 0) {
    throw new AppError(
      "Cannot delete access item referenced by active sponsorships",
      409,
      ErrorCodes.ACCESS_HAS_SPONSORSHIPS,
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
// Hierarchical Grouping (Type → Time Slots) — extracted to access-grouping.ts
// ============================================================================

export { getGroupedAccess } from "./access-grouping.js";

// ============================================================================
// Capacity Management
// ============================================================================

// Structural type for a db client that can be either the global prisma instance
// or a transaction client (tx). Matches the subset of operations used here.
type CapacityDbClient = Pick<TxClient, "$executeRaw" | "eventAccess">;

/**
 * Reserve access spot with atomic capacity check.
 * Uses raw SQL with atomic WHERE clause to prevent race conditions.
 * The capacity check is performed at the time of update, not using stale values.
 *
 * Pass `db` (the transaction client `tx`) when calling inside a $transaction
 * so the update participates in the transaction's rollback scope.
 */
export async function reserveAccessSpot(
  accessId: string,
  quantity: number = 1,
  db: CapacityDbClient = prisma,
): Promise<void> {
  // Use raw SQL for truly atomic capacity check and update
  // This ensures the check happens at the exact moment of update,
  // preventing TOCTOU race conditions
  const updateResult = await db.$executeRaw`
    UPDATE event_access
    SET registered_count = registered_count + ${quantity}
    WHERE id = ${accessId}
    AND (max_capacity IS NULL OR max_capacity - registered_count >= ${quantity})
  `;

  if (updateResult === 0) {
    // Either access not found or capacity exceeded - determine which
    const access = await db.eventAccess.findUnique({
      where: { id: accessId },
      select: { name: true, maxCapacity: true, registeredCount: true },
    });

    if (!access) {
      throw new AppError("Access not found", 404, ErrorCodes.ACCESS_NOT_FOUND);
    }

    const remaining = (access.maxCapacity ?? Infinity) - access.registeredCount;
    throw new AppError(
      `${access.name} has insufficient capacity (${remaining} spots remaining, requested ${quantity})`,
      409,
      ErrorCodes.ACCESS_CAPACITY_EXCEEDED,
    );
  }
}

/**
 * Release access spot with floor constraint to prevent negative counts.
 *
 * Pass `db` (the transaction client `tx`) when calling inside a $transaction
 * so the update participates in the transaction's rollback scope.
 */
export async function releaseAccessSpot(
  accessId: string,
  quantity: number = 1,
  db: CapacityDbClient = prisma,
): Promise<void> {
  const result = await db.eventAccess.updateMany({
    where: {
      id: accessId,
      registeredCount: { gte: quantity },
    },
    data: { registeredCount: { decrement: quantity } },
  });

  if (result.count === 0) {
    logger.warn(
      { accessId, quantity },
      "releaseAccessSpot: no rows updated — access item not found or registeredCount already below quantity",
    );
  }
}

// ============================================================================
// Validation — extracted to access-validation.ts
// ============================================================================

export { validateAccessSelections } from "./access-validation.js";

// ============================================================================
// Helpers
// ============================================================================
