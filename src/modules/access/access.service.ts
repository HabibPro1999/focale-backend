import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { logger } from "@shared/utils/logger.js";
import type { TxClient } from "@shared/types/prisma.js";
import type {
  CreateEventAccessInput,
  UpdateEventAccessInput,
} from "./access.schema.js";
import { Prisma, PaymentStatus } from "@/generated/prisma/client.js";
import type { EventAccess } from "@/generated/prisma/client.js";
import type { PriceBreakdown } from "@pricing";

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

  // If capacity is being lowered, check if we need to drop unpaid registrations
  const isCapacityChanging =
    data.maxCapacity !== undefined && data.maxCapacity !== access.maxCapacity;

  if (isCapacityChanging && data.maxCapacity !== null) {
    return prisma.$transaction(async (tx) => {
      const updated = await tx.eventAccess.update({
        where: { id },
        data: updateData,
        include: { requiredAccess: { select: { id: true, name: true } } },
      });
      if (updated.paidCount >= data.maxCapacity!) {
        await handleCapacityReached(access.eventId, [id], tx);
      }
      return updated;
    });
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

  // Remove this item from any other access items' prerequisite lists
  const dependents = await prisma.eventAccess.findMany({
    where: {
      requiredAccess: { some: { id } },
    },
    select: { id: true },
  });

  if (dependents.length > 0) {
    for (const dependent of dependents) {
      await prisma.eventAccess.update({
        where: { id: dependent.id },
        data: {
          requiredAccess: { disconnect: { id } },
        },
      });
    }
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
  // Use raw SQL for truly atomic capacity check and update.
  // Capacity is enforced against paid_count (settled registrations),
  // while registered_count tracks total registrations regardless of payment.
  const updateResult = await db.$executeRaw`
    UPDATE event_access
    SET registered_count = registered_count + ${quantity}
    WHERE id = ${accessId}
    AND (max_capacity IS NULL OR max_capacity - paid_count >= ${quantity})
  `;

  if (updateResult === 0) {
    // Either access not found or capacity exceeded - determine which
    const access = await db.eventAccess.findUnique({
      where: { id: accessId },
      select: { name: true, maxCapacity: true, paidCount: true },
    });

    if (!access) {
      throw new AppError("Access not found", 404, ErrorCodes.ACCESS_NOT_FOUND);
    }

    const remaining = (access.maxCapacity ?? Infinity) - access.paidCount;
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
// Paid Count (Capacity based on settled registrations)
// ============================================================================

const FULLY_SETTLED_STATUSES = ["PAID", "SPONSORED", "WAIVED"];

/**
 * Increment paid count when registration becomes settled.
 */
export async function incrementPaidCount(
  accessId: string,
  quantity: number = 1,
  db: CapacityDbClient = prisma,
): Promise<void> {
  await db.$executeRaw`
    UPDATE event_access
    SET paid_count = paid_count + ${quantity}
    WHERE id = ${accessId}
  `;
}

/**
 * Decrement paid count (with floor constraint).
 */
export async function decrementPaidCount(
  accessId: string,
  quantity: number = 1,
  db: CapacityDbClient = prisma,
): Promise<void> {
  await db.$executeRaw`
    UPDATE event_access
    SET paid_count = GREATEST(0, paid_count - ${quantity})
    WHERE id = ${accessId}
  `;
}

type CapacityReachedDbClient = CapacityDbClient & {
  registration: Pick<typeof prisma.registration, "findMany" | "update">;
  sponsorshipUsage: Pick<typeof prisma.sponsorshipUsage, "findMany">;
  auditLog: Pick<typeof prisma.auditLog, "create">;
};

/**
 * When paid count hits max capacity, drop access from unprotected registrations.
 *
 * "Unprotected" = NOT fully settled AND the access is NOT covered by a linked sponsorship.
 * PARTIAL registrations keep access items that are covered by their sponsorship's coveredAccessIds.
 */
export async function handleCapacityReached(
  eventId: string,
  accessIds: string[],
  db: CapacityReachedDbClient = prisma,
): Promise<number> {
  if (accessIds.length === 0) return 0;

  // Batch-fetch all access items in one query instead of N sequential reads
  const allAccesses = await db.eventAccess.findMany({
    where: { id: { in: accessIds } },
    select: { id: true, name: true, maxCapacity: true, paidCount: true },
  });

  const atCapacity = allAccesses.filter(
    (a) => a.maxCapacity !== null && a.paidCount >= a.maxCapacity,
  );

  let totalAffected = 0;

  for (const access of atCapacity) {
    const accessId = access.id;

    // Find registrations that have this access but are NOT fully settled
    const registrations = await db.registration.findMany({
      where: {
        eventId,
        paymentStatus: { notIn: [...FULLY_SETTLED_STATUSES, "REFUNDED"] as PaymentStatus[] },
        accessTypeIds: { has: accessId },
      },
      select: {
        id: true,
        accessTypeIds: true,
        droppedAccessIds: true,
        totalAmount: true,
        accessAmount: true,
        sponsorshipAmount: true,
        priceBreakdown: true,
      },
    });

    for (const reg of registrations) {
      // Check if this access is protected by a linked sponsorship (PARTIAL case)
      const usages = await db.sponsorshipUsage.findMany({
        where: { registrationId: reg.id },
        select: { sponsorship: { select: { coveredAccessIds: true } } },
      });
      const allCoveredAccessIds = usages.flatMap((u) => u.sponsorship.coveredAccessIds);
      if (allCoveredAccessIds.includes(accessId)) {
        continue; // This access is covered by sponsorship — don't drop it
      }

      // Drop this access from the registration
      const breakdown = reg.priceBreakdown as PriceBreakdown;
      const droppedItem = breakdown.accessItems.find((a) => a.accessId === accessId);
      if (!droppedItem) continue;

      const newAccessItems = breakdown.accessItems.filter((a) => a.accessId !== accessId);
      const newAccessTotal = newAccessItems.reduce((sum, a) => sum + a.subtotal, 0);
      const newSubtotal = breakdown.calculatedBasePrice + newAccessTotal;
      const newSponsorshipTotal = Math.min(breakdown.sponsorshipTotal, newSubtotal);
      const newTotal = Math.max(0, newSubtotal - newSponsorshipTotal);

      const updatedBreakdown = {
        ...breakdown,
        accessItems: newAccessItems,
        accessTotal: newAccessTotal,
        subtotal: newSubtotal,
        sponsorshipTotal: newSponsorshipTotal,
        total: newTotal,
        droppedAccessItems: [
          ...(breakdown.droppedAccessItems ?? []),
          { ...droppedItem, reason: "capacity_reached" as const },
        ],
      };

      await db.registration.update({
        where: { id: reg.id },
        data: {
          accessTypeIds: reg.accessTypeIds.filter((id) => id !== accessId),
          droppedAccessIds: [...(reg.droppedAccessIds ?? []), accessId],
          priceBreakdown: updatedBreakdown as unknown as Prisma.InputJsonValue,
          totalAmount: newTotal,
          accessAmount: newAccessTotal,
          sponsorshipAmount: newSponsorshipTotal,
        },
      });

      // Release the registered_count spot
      await releaseAccessSpot(accessId, droppedItem.quantity, db);

      await db.auditLog.create({
        data: {
          entityType: "Registration",
          entityId: reg.id,
          action: "ACCESS_CAPACITY_REACHED",
          changes: {
            accessDropped: { old: access.name, new: "capacity_reached" },
            totalAmount: { old: reg.totalAmount, new: newTotal },
            priceDeducted: { old: 0, new: droppedItem.subtotal },
          } as unknown as Prisma.InputJsonValue,
          performedBy: "SYSTEM",
        },
      });

      totalAffected++;
    }
  }

  return totalAffected;
}

// ============================================================================
// Validation — extracted to access-validation.ts
// ============================================================================

export { validateAccessSelections } from "./access-validation.js";

// ============================================================================
// Helpers
// ============================================================================
