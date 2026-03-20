import crypto from "node:crypto";
import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { compressImage } from "@shared/services/storage/compress.js";
import { getStorageProvider } from "@shared/services/storage/index.js";
import { clientExists } from "@clients";
import {
  paginate,
  getSkip,
  type PaginatedResult,
} from "@shared/utils/pagination.js";
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
    throw new AppError(
      "Client not found",
      404, ErrorCodes.NOT_FOUND);
  }

  // Check if slug already exists globally
  const existing = await prisma.event.findUnique({
    where: { slug },
  });
  if (existing) {
    throw new AppError(
      "Event with this slug already exists",
      409,
      ErrorCodes.CONFLICT,
    );
  }

  // Create Event and EventPricing atomically
  return prisma.$transaction(async (tx) => {
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
        status: status ?? "CLOSED",
      },
    });

    const pricing = await tx.eventPricing.create({
      data: {
        eventId: event.id,
        basePrice: basePrice ?? 0,
        currency: currency ?? "TND",
      },
    });

    return { ...event, pricing };
  });
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
 */
export async function updateEvent(
  id: string,
  input: UpdateEventInput,
): Promise<Event> {
  // Check if event exists
  const event = await prisma.event.findUnique({ where: { id } });
  if (!event) {
    throw new AppError(
      "Event not found",
      404, ErrorCodes.NOT_FOUND);
  }

  // Validate status transition if status is being changed
  if (input.status && input.status !== event.status) {
    const allowed = VALID_STATUS_TRANSITIONS[event.status] ?? [];
    if (!allowed.includes(input.status)) {
      throw new AppError(
      `Cannot transition event from ${event.status} to ${input.status}`,
      400,
        ErrorCodes.INVALID_STATUS_TRANSITION,
      );
    }
  }

  // If slug is being updated, check global uniqueness
  if (input.slug && input.slug !== event.slug) {
    const existing = await prisma.event.findUnique({
      where: { slug: input.slug },
    });
    if (existing) {
      throw new AppError(
      "Event with this slug already exists",
      409,
        ErrorCodes.CONFLICT,
      );
    }
  }

  return prisma.event.update({
    where: { id },
    data: input,
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
export async function deleteEvent(id: string): Promise<void> {
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
    throw new AppError(
      "Event not found",
      404, ErrorCodes.NOT_FOUND);
  }

  // Prevent deletion if event has registrations
  if (event._count.registrations > 0) {
    throw new AppError(
      `Cannot delete event with ${event._count.registrations} registration(s). Archive the event instead.`,
      409,
      ErrorCodes.EVENT_HAS_REGISTRATIONS,
    );
  }

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
 * Increment registered count for an event.
 */
export async function incrementRegisteredCount(id: string): Promise<Event> {
  return prisma.event.update({
    where: { id },
    data: { registeredCount: { increment: 1 } },
  });
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
      ErrorCodes.EVENT_FULL,
    );
  }
}

/**
 * Decrement registered count for an event.
 */
export async function decrementRegisteredCount(id: string): Promise<Event> {
  return prisma.event.update({
    where: { id },
    data: { registeredCount: { decrement: 1 } },
  });
}

/**
 * Upload and store an event banner image.
 * Compresses to WebP, uploads to storage, updates Event.bannerUrl.
 */
export async function uploadEventBanner(
  id: string,
  file: { buffer: Buffer; filename: string; mimetype: string },
): Promise<{ bannerUrl: string }> {
  if (!file.mimetype.startsWith("image/")) {
    throw new AppError(
      "Invalid file type. Only images are allowed.",
      400,
      ErrorCodes.INVALID_FILE_TYPE,
    );
  }

  const event = await prisma.event.findUnique({
    where: { id },
    select: { id: true, clientId: true },
  });
  if (!event) {
    throw new AppError(
      "Event not found",
      404, ErrorCodes.NOT_FOUND);
  }

  const compressed = await compressImage(file.buffer);
  const key = `${id}/banner/${crypto.randomUUID()}.webp`;
  const bannerUrl = await getStorageProvider().upload(
    compressed.buffer,
    key,
    "image/webp",
  );

  await prisma.event.update({ where: { id }, data: { bannerUrl } });

  return { bannerUrl };
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
