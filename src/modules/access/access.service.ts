import { randomUUID } from "crypto";
import { z } from "zod";
import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors.js";
import { ErrorCodes } from "@shared/errors.js";
import { AccessTypeSchema, AccessConditionSchema } from "./access.schema.js";
import { Prisma } from "@/generated/prisma/client.js";
import type { EventAccess } from "@/generated/prisma/client.js";
import { logger } from "@shared/utils/logger.js";

// ============================================================================
// Local Input Schemas
// ============================================================================

export const CreateEventAccessSchema = z
  .object({
    eventId: z.string().uuid(),
    type: AccessTypeSchema.default("OTHER"),
    name: z.string().min(1).max(200),
    description: z.string().max(1000).optional().nullable(),
    location: z.string().max(500).optional().nullable(),

    // Scheduling
    startsAt: z.coerce.date().optional().nullable(),
    endsAt: z.coerce.date().optional().nullable(),

    // Pricing
    price: z.number().int().min(0).default(0),
    currency: z.string().length(3).default("TND"),

    // Capacity
    maxCapacity: z.number().int().positive().optional().nullable(),

    // Availability
    availableFrom: z.coerce.date().optional().nullable(),
    availableTo: z.coerce.date().optional().nullable(),

    // Conditions (form-based prerequisites)
    conditions: z.array(AccessConditionSchema).optional().nullable(),
    conditionLogic: z.enum(["and", "or"]).default("and"),

    // Access-based prerequisites (array of access IDs)
    requiredAccessIds: z.array(z.string().uuid()).optional().default([]),

    // Display
    sortOrder: z.number().int().default(0),
    active: z.boolean().default(true),

    // Custom grouping (for OTHER type - allows custom group labels)
    groupLabel: z.string().max(100).optional().nullable(),

    // Companion option (show +1 question in registration form)
    allowCompanion: z.boolean().default(false),
  })
  .strict()
  .refine(
    (data) => {
      if (data.startsAt && data.endsAt) {
        return data.endsAt >= data.startsAt;
      }
      return true;
    },
    { message: "End time must be after start time", path: ["endsAt"] },
  );

export const UpdateEventAccessSchema = z
  .object({
    type: AccessTypeSchema.optional(),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).optional().nullable(),
    location: z.string().max(500).optional().nullable(),
    startsAt: z.coerce.date().optional().nullable(),
    endsAt: z.coerce.date().optional().nullable(),
    price: z.number().int().min(0).optional(),
    currency: z.string().length(3).optional(),
    maxCapacity: z.number().int().positive().optional().nullable(),
    availableFrom: z.coerce.date().optional().nullable(),
    availableTo: z.coerce.date().optional().nullable(),
    conditions: z.array(AccessConditionSchema).optional().nullable(),
    conditionLogic: z.enum(["and", "or"]).optional(),
    requiredAccessIds: z.array(z.string().uuid()).optional(),
    sortOrder: z.number().int().optional(),
    active: z.boolean().optional(),
    groupLabel: z.string().max(100).optional().nullable(),
    allowCompanion: z.boolean().optional(),
  })
  .strict()
  .refine(
    (data) => {
      if (data.startsAt && data.endsAt) {
        return data.endsAt >= data.startsAt;
      }
      return true;
    },
    { message: "End time must be after start time", path: ["endsAt"] },
  );

export type CreateEventAccessInput = z.infer<typeof CreateEventAccessSchema>;
export type UpdateEventAccessInput = z.infer<typeof UpdateEventAccessSchema>;

// ============================================================================
// Types
// ============================================================================

// Full Prisma interactive transaction client type.
// Using the full type allows service functions to use any Prisma model method
// (e.g., eventAccess.findUnique) in addition to raw query methods.
type TransactionClient = Parameters<
  Parameters<typeof prisma.$transaction>[0]
>[0];

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
export function validateAccessDatesAgainstEvent(
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

/**
 * Validates that prerequisite access IDs exist in the same event and have no
 * circular dependency with the given access item.
 * @param eventId - The event context
 * @param accessId - The access item being created/updated (use a temp UUID for new items)
 * @param requiredAccessIds - The proposed prerequisite IDs
 * @param notFoundMessage - Error message when prerequisites are missing
 */
async function validatePrerequisites(
  eventId: string,
  accessId: string,
  requiredAccessIds: string[],
  notFoundMessage: string,
): Promise<void> {
  if (requiredAccessIds.length === 0) return;

  const prerequisites = await prisma.eventAccess.findMany({
    where: { id: { in: requiredAccessIds }, eventId },
  });
  if (prerequisites.length !== requiredAccessIds.length) {
    throw new AppError(notFoundMessage, 400, true, ErrorCodes.BAD_REQUEST);
  }

  const hasCycle = await detectCircularPrerequisites(
    eventId,
    accessId,
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

export async function createEventAccess(
  input: CreateEventAccessInput,
): Promise<EventAccessWithPrerequisites> {
  const { eventId, requiredAccessIds, ...data } = input;

  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, startDate: true, endDate: true },
  });
  if (!event) {
    throw new AppError("Event not found", 404, true, ErrorCodes.NOT_FOUND);
  }

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

  // For new items, use a temp UUID for the circular dependency graph check
  if (requiredAccessIds && requiredAccessIds.length > 0) {
    await validatePrerequisites(
      eventId,
      randomUUID(),
      requiredAccessIds,
      "One or more prerequisite access items not found or belong to different event",
    );
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
      conditionLogic: data.conditionLogic ?? "and",
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

/**
 * Build the Prisma update payload from a partial UpdateEventAccessInput.
 * Does not include requiredAccess — that is handled separately.
 */
function buildAccessUpdateData(
  data: Omit<UpdateEventAccessInput, "requiredAccessIds">,
): Prisma.EventAccessUpdateInput {
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

  return updateData;
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

  const updateData = buildAccessUpdateData(data);

  if (requiredAccessIds !== undefined) {
    await validatePrerequisites(
      access.eventId,
      id,
      requiredAccessIds,
      "One or more prerequisite access items not found",
    );
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
  await prisma.$transaction(async (tx) => {
    const access = await tx.eventAccess.findUnique({ where: { id } });
    if (!access) {
      throw new AppError(
        "Access item not found",
        404,
        true,
        ErrorCodes.ACCESS_NOT_FOUND,
      );
    }

    // Check if any registrations have selected this access
    const registrationCount = await tx.registration.count({
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

    // Check if any other access items depend on this item as a prerequisite
    const dependentCount = await tx.eventAccess.count({
      where: { requiredAccess: { some: { id } } },
    });
    if (dependentCount > 0) {
      throw new AppError(
        "Cannot delete: other access items depend on this item as a prerequisite",
        409,
        true,
        ErrorCodes.ACCESS_HAS_PREREQUISITES,
      );
    }

    await tx.eventAccess.delete({ where: { id } });
  });
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
): Promise<
  (EventAccessWithPrerequisites & { event: { clientId: string } }) | null
> {
  return prisma.eventAccess.findUnique({
    where: { id },
    include: {
      requiredAccess: { select: { id: true, name: true } },
      event: { select: { clientId: true } },
    },
  });
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
    // Either access not found or capacity exceeded - determine which.
    // Use the transaction client (or global prisma when no tx is active) so
    // the read is consistent with the failed update within the same transaction.
    const client = tx ?? prisma;
    const access = await client.eventAccess.findUnique({
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
  const result = await (tx ?? prisma).$executeRaw`
    UPDATE event_access
    SET registered_count = GREATEST(0, registered_count - ${quantity})
    WHERE id = ${accessId}
  `;
  if (result === 0) {
    logger.warn(
      { accessId, quantity },
      "releaseAccessSpot: no rows updated (access item not found)",
    );
  }
}

