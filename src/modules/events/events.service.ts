import crypto from "node:crypto";
import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { compressImage } from "@shared/services/storage/compress.js";
import { getStorageProvider } from "@shared/services/storage/index.js";
import { logger } from "@shared/utils/logger.js";
import { clientExists } from "@clients";
import { fileTypeFromBuffer } from "file-type";
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
import type { TxClient } from "@shared/types/prisma.js";

// Transaction client type — minimal subset needed for raw capacity queries
type TransactionClient = Pick<TxClient, "$executeRaw">;

// Type for Event with pricing included
type EventWithPricing = Event & { pricing: EventPricing | null };

function normalizeBasePrice(basePrice: number | null | undefined): number {
  return basePrice ?? 0;
}

export function assertEventWritable(event: Pick<Event, "status">): void {
  if (event.status === "ARCHIVED") {
    throw new AppError(
      "Archived events cannot be modified",
      400,
      ErrorCodes.INVALID_STATUS_TRANSITION,
    );
  }
}

export function assertEventOpen(event: Pick<Event, "status">): void {
  if (event.status !== "OPEN") {
    throw new AppError(
      "Event is not accepting public actions",
      400,
      ErrorCodes.EVENT_NOT_OPEN,
    );
  }
}

function extractKeyFromStorage(value: string): string | null {
  if (!value.includes("://")) {
    return value || null;
  }

  try {
    const parsed = new URL(value);
    if (parsed.hostname === "storage.googleapis.com") {
      const parts = parsed.pathname.split("/").filter(Boolean);
      return decodeURIComponent(parts.slice(1).join("/"));
    }
    return decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    return null;
  }
}

async function deleteStoredObjectBestEffort(
  location: string | null | undefined,
  context: Record<string, unknown>,
): Promise<void> {
  if (!location) return;
  const key = extractKeyFromStorage(location);
  if (!key) return;

  try {
    await getStorageProvider().delete(key);
  } catch (err) {
    logger.warn({ err, key, ...context }, "Failed to delete stored event file");
  }
}

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
    basePrice,
    currency,
  } = input;

  // Validate that client exists
  const isValidClient = await clientExists(clientId);
  if (!isValidClient) {
    throw new AppError("Client not found", 404, ErrorCodes.NOT_FOUND);
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
        status: "CLOSED",
      },
    });

    const pricing = await tx.eventPricing.create({
      data: {
        eventId: event.id,
        basePrice: normalizeBasePrice(basePrice),
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
): Promise<EventWithPricing> {
  // Check if event exists
  const event = await prisma.event.findUnique({ where: { id } });
  if (!event) {
    throw new AppError("Event not found", 404, ErrorCodes.NOT_FOUND);
  }

  if (Object.values(input).every((value) => value === undefined)) {
    throw new AppError(
      "At least one field must be provided for update",
      400,
      ErrorCodes.VALIDATION_ERROR,
    );
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
  assertEventWritable(event);

  // Validate resulting date range (schema only checks when both are provided)
  const resultingStart = input.startDate ?? event.startDate;
  const resultingEnd = input.endDate ?? event.endDate;
  if (resultingEnd < resultingStart) {
    throw new AppError(
      "End date must be greater than or equal to start date",
      400,
      ErrorCodes.VALIDATION_ERROR,
    );
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

  const { basePrice, currency, ...eventData } = input;

  // Block currency change if registrations exist
  if (currency !== undefined) {
    const existingPricing = await prisma.eventPricing.findUnique({
      where: { eventId: id },
      select: { currency: true },
    });
    const currentCurrency = existingPricing?.currency ?? "TND";
    if (currency !== currentCurrency) {
      const registrationCount = await prisma.registration.count({
        where: { eventId: id },
      });
      if (registrationCount > 0) {
        throw new AppError(
          "Cannot change currency after registrations exist",
          400,
          ErrorCodes.VALIDATION_ERROR,
        );
      }
    }
  }

  if (basePrice !== undefined || currency !== undefined) {
    return prisma.$transaction(async (tx) => {
      await tx.event.update({
        where: { id },
        data: eventData,
        include: { pricing: true },
      });

      const pricingData: { basePrice?: number; currency?: string } = {};
      if (basePrice !== undefined)
        pricingData.basePrice = normalizeBasePrice(basePrice);
      if (currency !== undefined) pricingData.currency = currency;

      await tx.eventPricing.upsert({
        where: { eventId: id },
        update: pricingData,
        create: {
          eventId: id,
          basePrice: pricingData.basePrice ?? 0,
          currency: pricingData.currency ?? "TND",
        },
      });

      // Re-fetch with updated pricing
      return tx.event.findUniqueOrThrow({
        where: { id },
        include: { pricing: true },
      });
    });
  }

  return prisma.event.update({
    where: { id },
    data: eventData,
    include: { pricing: true },
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
    throw new AppError("Event not found", 404, ErrorCodes.NOT_FOUND);
  }

  // Prevent deletion if event has registrations
  if (event._count.registrations > 0) {
    throw new AppError(
      `Cannot delete event with ${event._count.registrations} registration(s). Archive the event instead.`,
      409,
      ErrorCodes.EVENT_HAS_REGISTRATIONS,
    );
  }

  const certificateTemplateImages =
    (await prisma.certificateTemplate.findMany({
      where: { eventId: id },
      select: { templateUrl: true },
    })) ?? [];

  await prisma.$transaction(async (tx) => {
    await tx.emailTemplate.deleteMany({ where: { eventId: id } });
    await tx.event.delete({ where: { id } });
  });

  await Promise.all([
    deleteStoredObjectBestEffort(event.bannerUrl, { eventId: id }),
    ...certificateTemplateImages.map((template) =>
      deleteStoredObjectBestEffort(template.templateUrl, { eventId: id }),
    ),
  ]);
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
    throw new AppError("Event is at capacity", 409, ErrorCodes.EVENT_FULL);
  }
}

/**
 * Upload and store an event banner image.
 * Compresses to WebP, uploads to storage, updates Event.bannerUrl.
 */
export async function uploadEventBanner(
  id: string,
  file: { buffer: Buffer; filename: string; mimetype: string },
): Promise<{ bannerUrl: string }> {
  const event = await prisma.event.findUnique({
    where: { id },
    select: { id: true, clientId: true, status: true, bannerUrl: true },
  });
  if (!event) {
    throw new AppError("Event not found", 404, ErrorCodes.NOT_FOUND);
  }
  assertEventWritable(event);

  const detectedType = await fileTypeFromBuffer(file.buffer);
  if (!detectedType?.mime.startsWith("image/")) {
    throw new AppError(
      "Invalid file content. Only real images are allowed.",
      400,
      ErrorCodes.INVALID_FILE_TYPE,
    );
  }

  const compressed = await compressImage(file.buffer);
  const key = `${id}/banner/${crypto.randomUUID()}.webp`;
  const storage = getStorageProvider();
  const bannerUrl = await storage.uploadPublic(
    compressed.buffer,
    key,
    "image/webp",
  );

  try {
    await prisma.event.update({ where: { id }, data: { bannerUrl } });
  } catch (err) {
    await deleteStoredObjectBestEffort(bannerUrl, { eventId: id });
    throw err;
  }

  await deleteStoredObjectBestEffort(event.bannerUrl, { eventId: id });

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
