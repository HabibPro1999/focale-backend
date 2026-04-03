import { prisma } from "@/database/client.js";
import {
  paginate,
  getSkip,
  type PaginatedResult,
} from "@shared/utils/pagination.js";
import type { Prisma } from "@/generated/prisma/client.js";
import type { ListRegistrationsQuery } from "./registrations.schema.js";
import {
  enrichWithAccessSelections,
  enrichManyWithAccessSelections,
  type RegistrationWithRelations,
} from "./registration-enrichment.js";

// ============================================================================
// Read Operations
// ============================================================================

export async function getRegistrationById(
  id: string,
): Promise<RegistrationWithRelations | null> {
  const registration = await prisma.registration.findUnique({
    where: { id },
    include: {
      form: { select: { id: true, name: true } },
      event: { select: { id: true, name: true, slug: true, clientId: true } },
    },
  });

  if (!registration) return null;

  const enriched = await enrichWithAccessSelections(registration);
  // M23: strip editToken from admin responses
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { editToken: _, ...safeResult } = enriched;
  return safeResult as RegistrationWithRelations;
}

/**
 * Get registration by idempotency key.
 * Used for idempotent registration creation.
 */
export async function getRegistrationByIdempotencyKey(
  idempotencyKey: string,
): Promise<RegistrationWithRelations | null> {
  const registration = await prisma.registration.findUnique({
    where: { idempotencyKey },
    include: {
      form: { select: { id: true, name: true } },
      event: { select: { id: true, name: true, slug: true, clientId: true } },
    },
  });

  if (!registration) return null;

  return enrichWithAccessSelections(registration);
}

// ============================================================================
// List Registrations
// ============================================================================

export async function listRegistrations(
  eventId: string,
  query: ListRegistrationsQuery,
): Promise<PaginatedResult<RegistrationWithRelations>> {
  const { page, limit, paymentStatus, paymentMethod, search } = query;

  const where: Prisma.RegistrationWhereInput = { eventId };

  if (paymentStatus) where.paymentStatus = paymentStatus;
  if (paymentMethod) where.paymentMethod = paymentMethod;
  if (search) {
    where.OR = [
      { email: { contains: search, mode: "insensitive" } },
      { firstName: { contains: search, mode: "insensitive" } },
      { lastName: { contains: search, mode: "insensitive" } },
      { phone: { contains: search, mode: "insensitive" } },
      { referenceNumber: { contains: search, mode: "insensitive" } },
    ];
  }

  const skip = getSkip({ page, limit });

  const [data, total] = await Promise.all([
    prisma.registration.findMany({
      where,
      skip,
      take: limit,
      include: {
        form: { select: { id: true, name: true } },
        event: {
          select: {
            id: true,
            name: true,
            slug: true,
            clientId: true,
            startDate: true,
            location: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.registration.count({ where }),
  ]);

  // Enrich with accessSelections derived from priceBreakdown
  const enrichedData = await enrichManyWithAccessSelections(data);

  return paginate(enrichedData, total, { page, limit });
}

// ============================================================================
// Helpers
// ============================================================================

export async function getRegistrationClientId(
  id: string,
): Promise<string | null> {
  const registration = await prisma.registration.findUnique({
    where: { id },
    include: { event: { select: { clientId: true } } },
  });
  return registration?.event.clientId ?? null;
}
