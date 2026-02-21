import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { clientExists } from "@clients";
import {
  paginate,
  getSkip,
  type PaginatedResult,
} from "@shared/utils/pagination.js";
import { auditLog, diffChanges } from "@shared/utils/audit.js";
import type {
  CreateEventInput,
  UpdateEventInput,
  ListEventsQuery,
} from "./events.schema.js";
import type { Event, EventPricing, Prisma } from "@/generated/prisma/client.js";

// Transaction client type that works with Prisma extensions
type TransactionClient = { $executeRaw: typeof prisma.$executeRaw };

// Type for Event with pricing included
type EventWithPricing = Event & { pricing: EventPricing | null };

/**
 * Create a new event with pricing configuration.
 * Creates both Event and EventPricing atomically.
 */
export async function createEvent(
  input: CreateEventInput,
  performedBy: string,
): Promise<EventWithPricing> {
  const {
    clientId,
    name,
    slug,
    description,
    maxCapacity,
    startDate,
    endDate,
    location,
    status,
    basePrice,
    currency,
  } = input;

  // Validate that client exists
  const isValidClient = await clientExists(clientId);
  if (!isValidClient) {
    throw new AppError("Client not found", 404, true, ErrorCodes.NOT_FOUND);
  }

  // Create Event and EventPricing atomically
  const result = await prisma.$transaction(async (tx) => {
    // Check if slug already exists globally
    const existing = await tx.event.findUnique({
      where: { slug },
    });
    if (existing) {
      throw new AppError(
        "Event with this slug already exists",
        409,
        true,
        ErrorCodes.CONFLICT,
      );
    }

    const event = await tx.event.create({
      data: {
        clientId,
        name,
        slug,
        description: description ?? null,
        maxCapacity: maxCapacity ?? null,
        startDate,
        endDate,
        location: location ?? null,
        status,
      },
    });

    const pricing = await tx.eventPricing.create({
      data: {
        eventId: event.id,
        basePrice,
        currency,
      },
    });

    return { ...event, pricing };
  });

  // Log after transaction succeeds
  await auditLog(prisma, {
    entityType: "Event",
    entityId: result.id,
    action: "CREATE",
    performedBy,
  });

  return result;
}

/**
 * Get event by ID with pricing.
 */
export async function getEventById(
  id: string,
): Promise<EventWithPricing | null> {
  return prisma.event.findUnique({
    where: { id },
    include: { pricing: true },
  });
}

/**
 * Get event by slug (for public access).
 */
export async function getEventBySlug(
  slug: string,
): Promise<EventWithPricing | null> {
  return prisma.event.findUnique({
    where: { slug },
    include: { pricing: true },
  });
}

// Valid event status transitions: CLOSED -> OPEN -> ARCHIVED (terminal)
const VALID_STATUS_TRANSITIONS: Record<string, string[]> = {
  CLOSED: ["OPEN"],
  OPEN: ["CLOSED", "ARCHIVED"],
  ARCHIVED: [], // Terminal state - no transitions allowed
};

/**
 * Update event.
 *
 * @param prefetchedEvent - Optional event already fetched by the caller (e.g.
 *   from requireEventAccess). When provided the initial DB read is skipped.
 *   The event must have been fetched with `include: { pricing: true }`.
 */
export async function updateEvent(
  id: string,
  input: UpdateEventInput,
  performedBy: string,
  prefetchedEvent?: EventWithPricing,
): Promise<EventWithPricing> {
  // Use the pre-fetched event when available to avoid a redundant DB read
  const event =
    prefetchedEvent ??
    (await prisma.event.findUnique({
      where: { id },
      include: { pricing: true },
    }));
  if (!event) {
    throw new AppError("Event not found", 404, true, ErrorCodes.NOT_FOUND);
  }

  // Validate status transition if status is being changed
  if (input.status && input.status !== event.status) {
    const allowed = VALID_STATUS_TRANSITIONS[event.status] ?? [];
    if (!allowed.includes(input.status)) {
      throw new AppError(
        `Cannot transition event from ${event.status} to ${input.status}`,
        400,
        true,
        ErrorCodes.INVALID_STATUS_TRANSITION,
      );
    }
  }

  // Validate dates when partially updated
  const effectiveStartDate = input.startDate ?? event.startDate;
  const effectiveEndDate = input.endDate ?? event.endDate;

  if (effectiveEndDate < effectiveStartDate) {
    throw new AppError(
      "End date must be greater than or equal to start date",
      400,
      true,
      ErrorCodes.VALIDATION_ERROR,
    );
  }

  return prisma.$transaction(async (tx) => {
    // If slug is being updated, check global uniqueness inside transaction
    if (input.slug && input.slug !== event.slug) {
      const existing = await tx.event.findUnique({
        where: { slug: input.slug },
      });
      if (existing) {
        throw new AppError(
          "Event with this slug already exists",
          409,
          true,
          ErrorCodes.CONFLICT,
        );
      }
    }

    const updatedEvent = await tx.event.update({
      where: { id },
      data: input,
      include: { pricing: true },
    });

    // Log update inside transaction
    const relevantFields: (keyof typeof event)[] = [
      "name",
      "slug",
      "description",
      "maxCapacity",
      "startDate",
      "endDate",
      "location",
      "status",
    ];
    const changes = diffChanges(event, updatedEvent, relevantFields);

    await auditLog(tx, {
      entityType: "Event",
      entityId: id,
      action: "UPDATE",
      changes,
      performedBy,
    });

    return updatedEvent;
  });
}

/**
 * List events with pagination and filters.
 */
export async function listEvents(
  query: ListEventsQuery,
): Promise<PaginatedResult<Event>> {
  const { page, limit, clientId, status, search } = query;
  const skip = getSkip({ page, limit });

  const where: Prisma.EventWhereInput = {};

  if (clientId) where.clientId = clientId;
  if (status) where.status = status;
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { slug: { contains: search, mode: "insensitive" } },
      { description: { contains: search, mode: "insensitive" } },
      { location: { contains: search, mode: "insensitive" } },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.event.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
    prisma.event.count({ where }),
  ]);

  return paginate(data, total, { page, limit });
}

/**
 * Delete event.
 * Prevents deletion if event has registrations - use archive instead.
 */
export async function deleteEvent(
  id: string,
  performedBy: string,
): Promise<void> {
  // Check if event exists and count related data
  const event = await prisma.event.findUnique({
    where: { id },
    include: {
      _count: {
        select: {
          registrations: true,
        },
      },
    },
  });

  if (!event) {
    throw new AppError("Event not found", 404, true, ErrorCodes.NOT_FOUND);
  }

  // Prevent deletion if event has registrations
  if (event._count.registrations > 0) {
    throw new AppError(
      `Cannot delete event with ${event._count.registrations} registration(s). Archive the event instead.`,
      409,
      true,
      ErrorCodes.EVENT_HAS_REGISTRATIONS,
    );
  }

  // Log deletion before deleting
  await auditLog(prisma, {
    entityType: "Event",
    entityId: id,
    action: "DELETE",
    performedBy,
  });

  await prisma.event.delete({ where: { id } });
}

/**
 * Helper function to check if event exists (for validation in other modules).
 */
export async function eventExists(id: string): Promise<boolean> {
  const count = await prisma.event.count({ where: { id } });
  return count > 0;
}

/**
 * Atomic increment of registered count within a transaction.
 * Uses raw SQL to prevent race conditions under concurrent load.
 */
export async function incrementRegisteredCountTx(
  tx: TransactionClient,
  id: string,
): Promise<void> {
  const result = await tx.$executeRaw`
    UPDATE "events"
    SET registered_count = registered_count + 1
    WHERE id = ${id}
    AND (max_capacity IS NULL OR registered_count < max_capacity)
  `;

  if (result === 0) {
    throw new AppError(
      "Event is at capacity",
      409,
      true,
      ErrorCodes.EVENT_FULL,
    );
  }
}

/**
 * Atomic decrement of registered count within a transaction.
 */
export async function decrementRegisteredCountTx(
  tx: TransactionClient,
  id: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "events"
    SET registered_count = GREATEST(0, registered_count - 1)
    WHERE id = ${id}
  `;
}
