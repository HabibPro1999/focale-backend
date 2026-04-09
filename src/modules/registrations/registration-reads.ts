import { prisma } from "@/database/client.js";
import {
  paginate,
  getSkip,
  type PaginatedResult,
} from "@shared/utils/pagination.js";
import type { Prisma } from "@/generated/prisma/client.js";
import type { ListRegistrationsQuery, RegistrationStats } from "./registrations.schema.js";
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
// Shared Where-Clause Builder
// ============================================================================

export function buildRegistrationWhere(
  eventId: string,
  filters?: { paymentStatus?: string; paymentMethod?: string; search?: string },
): Prisma.RegistrationWhereInput {
  const where: Prisma.RegistrationWhereInput = { eventId };
  if (filters?.paymentStatus) {
    where.paymentStatus = filters.paymentStatus as Prisma.RegistrationWhereInput["paymentStatus"];
  }
  if (filters?.paymentMethod) {
    where.paymentMethod = filters.paymentMethod as Prisma.RegistrationWhereInput["paymentMethod"];
  }
  if (filters?.search) {
    where.OR = [
      { email: { contains: filters.search, mode: "insensitive" } },
      { firstName: { contains: filters.search, mode: "insensitive" } },
      { lastName: { contains: filters.search, mode: "insensitive" } },
      { phone: { contains: filters.search, mode: "insensitive" } },
      { referenceNumber: { contains: filters.search, mode: "insensitive" } },
    ];
  }
  return where;
}

// ============================================================================
// List Registrations
// ============================================================================

export async function listRegistrations(
  eventId: string,
  query: ListRegistrationsQuery,
): Promise<PaginatedResult<RegistrationWithRelations> & { stats: RegistrationStats }> {
  const { page, limit, paymentStatus, paymentMethod, search } = query;

  const where = buildRegistrationWhere(eventId, { paymentStatus, paymentMethod, search });

  const skip = getSkip({ page, limit });

  const [data, total, statsRaw] = await Promise.all([
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
    prisma.registration.groupBy({
      by: ["paymentStatus"],
      where,
      _count: true,
      _sum: { totalAmount: true, paidAmount: true },
    }),
  ]);

  const stats: RegistrationStats = {
    total: 0,
    totalAmount: 0,
    paid: { count: 0, amount: 0 },
    pending: { count: 0, amount: 0 },
    sponsored: { count: 0, amount: 0 },
  };
  for (const row of statsRaw) {
    const count = row._count;
    const amount = row._sum.totalAmount ?? 0;
    stats.total += count;
    stats.totalAmount += amount;
    if (row.paymentStatus === "PAID") {
      stats.paid = { count, amount: row._sum.paidAmount ?? 0 };
    } else if (row.paymentStatus === "PENDING" || row.paymentStatus === "VERIFYING" || row.paymentStatus === "PARTIAL") {
      stats.pending.count += count;
      stats.pending.amount += amount;
    } else if (row.paymentStatus === "SPONSORED" || row.paymentStatus === "WAIVED") {
      stats.sponsored.count += count;
      stats.sponsored.amount += amount;
    }
  }

  // Enrich with accessSelections derived from priceBreakdown
  const enrichedData = await enrichManyWithAccessSelections(data);

  return { ...paginate(enrichedData, total, { page, limit }), stats };
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
