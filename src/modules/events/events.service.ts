import { prisma } from "@/database/client.js";
import { AppError, ErrorCodes } from "@shared/errors.js";
import { compressImage } from "@shared/services/storage/compress.js";
import { getStorageProvider } from "@shared/services/storage/index.js";
import { clientExists } from "@clients";
import {
  paginate,
  getSkip,
  type PaginatedResult,
} from "@shared/utils/pagination.js";
import { auditLog, diffChanges } from "@shared/utils/audit.js";
import { z } from "zod";
import { Event } from "./events.schema.js";
import {
  Prisma,
  type Event as PrismaEvent,
  type EventPricing,
  type EventStatus,
} from "@/generated/prisma/client.js";

type CreateEventInput = z.infer<typeof Event> & {
  clientId: string;
};

type UpdateEventInput = Partial<z.infer<typeof Event>>;

type ListEventsQuery = {
  page: number;
  limit: number;
  search?: string;
  clientId?: string;
  status?: EventStatus;
};

// Transaction client type that works with Prisma extensions
type TransactionClient = { $executeRaw: typeof prisma.$executeRaw };

// Type for Event with pricing included
type EventWithPricing = PrismaEvent & { pricing: EventPricing | null };

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
  } = input;

  // Create Event and EventPricing atomically
  let result: EventWithPricing;
  try {
    result = await prisma.$transaction(async (tx) => {
      // Validate that client exists inside transaction to prevent TOCTOU race
      const clientRecord = await clientExists(clientId);
      if (!clientRecord) {
        throw new AppError("Client not found", 404, true, ErrorCodes.NOT_FOUND);
      }

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
          basePrice: 0,
          currency: "TND",
        },
      });

      return { ...event, pricing };
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new AppError(
        "Event with this slug already exists",
        409,
        true,
        ErrorCodes.CONFLICT,
      );
    }
    throw error;
  }

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
const VALID_STATUS_TRANSITIONS: Record<EventStatus, EventStatus[]> = {
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

  // Guard: ARCHIVED events only allow status transitions — field edits are rejected.
  // ARCHIVED is a terminal state; its data must remain immutable for audit purposes.
  const nonStatusKeys = Object.keys(input).filter((k) => k !== "status");
  if (event.status === "ARCHIVED" && nonStatusKeys.length > 0) {
    throw new AppError(
      "Archived events cannot be edited. Only status transitions are allowed.",
      409,
      true,
      ErrorCodes.INVALID_STATUS_TRANSITION,
    );
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

  // Validate dates when partially updated.
  // Intentional duplication: route-level refine catches full-object invalid pairs early
  // (better error path); service-level catches cross-field partial updates where only
  // one date is provided and must be reconciled against the stored value.
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

  try {
    return await prisma.$transaction(async (tx) => {
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
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new AppError(
        "Event with this slug already exists",
        409,
        true,
        ErrorCodes.CONFLICT,
      );
    }
    throw error;
  }
}

/**
 * List events with pagination and filters.
 * Returns events WITHOUT pricing or form includes — callers needing pricing
 * should use getEventById instead.
 */
export async function listEvents(
  query: ListEventsQuery,
): Promise<PaginatedResult<PrismaEvent>> {
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
  await prisma.$transaction(async (tx) => {
    const event = await tx.event.findUnique({
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

    await auditLog(tx, {
      entityType: "Event",
      entityId: id,
      action: "DELETE",
      performedBy,
    });

    await tx.event.delete({ where: { id } });
  });
}

/**
 * Helper function to check if event exists (for validation in other modules).
 */
export async function eventExists(id: string): Promise<boolean> {
  const result = await prisma.event.findUnique({
    where: { id },
    select: { id: true },
  });
  return !!result;
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
  const result = await tx.$executeRaw`
    UPDATE "events"
    SET registered_count = GREATEST(0, registered_count - 1)
    WHERE id = ${id}
  `;

  if (result === 0) {
    throw new AppError("Event not found", 404, true, ErrorCodes.NOT_FOUND);
  }
}

/**
 * Upload event banner image.
 * Compresses to WebP and stores via configured storage provider.
 */
export async function uploadEventBanner(
  eventId: string,
  file: { buffer: Buffer; filename: string; mimetype: string },
  performedBy: string,
): Promise<{ bannerUrl: string }> {
  const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];

  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    throw new AppError(
      "Invalid file type. Allowed: PNG, JPG, WebP",
      400,
      true,
      ErrorCodes.INVALID_FILE_TYPE,
    );
  }

  const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
  if (file.buffer.length > MAX_FILE_SIZE) {
    throw new AppError(
      "File too large. Maximum: 5MB",
      400,
      true,
      ErrorCodes.FILE_TOO_LARGE,
    );
  }

  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, bannerUrl: true },
  });

  if (!event) {
    throw new AppError("Event not found", 404, true, ErrorCodes.NOT_FOUND);
  }

  const compressed = await compressImage(file.buffer);
  const key = `events/${eventId}/banner.${compressed.ext}`;
  const storage = getStorageProvider();

  // Delete old banner if exists
  if (event.bannerUrl) {
    try {
      const parsed = new URL(event.bannerUrl);
      // Firebase: /bucket-name/path → strip bucket; R2/custom: /path → use as-is
      const oldKey =
        parsed.hostname === "storage.googleapis.com"
          ? parsed.pathname.split("/").filter(Boolean).slice(1).join("/")
          : parsed.pathname.slice(1);
      if (oldKey) await storage.delete(oldKey);
    } catch {
      // Ignore delete errors for old banner
    }
  }

  const bannerUrl = await storage.upload(
    compressed.buffer,
    key,
    compressed.contentType,
  );

  await prisma.$transaction(async (tx) => {
    await tx.event.update({
      where: { id: eventId },
      data: { bannerUrl },
    });

    await tx.auditLog.create({
      data: {
        entityType: "Event",
        entityId: eventId,
        action: "UPDATE",
        changes: {
          bannerUrl: { old: event.bannerUrl, new: bannerUrl },
        },
        performedBy,
      },
    });
  });

  return { bannerUrl };
}
