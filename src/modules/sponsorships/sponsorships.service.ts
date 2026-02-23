import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors.js";
import { ErrorCodes } from "@shared/errors.js";
import {
  paginate,
  getSkip,
  type PaginatedResult,
} from "@shared/utils/pagination.js";
import {
  calculateSponsorshipTotal,
  validateCoveredAccessTimeOverlap,
} from "./sponsorships.utils.js";
import type { SponsorshipStatus } from "./sponsorships.schema.js";

// Local types derived from inlined route schemas (not imported from schema file)
type ListSponsorshipsQuery = {
  page: number;
  limit: number;
  search?: string;
  status?: SponsorshipStatus;
  sortBy: "createdAt" | "totalAmount" | "beneficiaryName";
  sortOrder: "asc" | "desc";
};

type UpdateSponsorshipInput = {
  beneficiaryName?: string;
  beneficiaryEmail?: string;
  beneficiaryPhone?: string | null;
  beneficiaryAddress?: string | null;
  coversBasePrice?: boolean;
  coveredAccessIds?: string[];
  status?: "CANCELLED";
};
import type {
  Prisma,
  Sponsorship,
  SponsorshipBatch,
  SponsorshipUsage,
} from "@/generated/prisma/client.js";
import {
  recalculateUsageAmounts,
  unlinkSponsorshipFromRegistrationInternal,
} from "./sponsorships-linking.service.js";

// ============================================================================
// Types
// ============================================================================

type SponsorshipWithBatch = Sponsorship & {
  batch: {
    id: string;
    labName: string;
    contactName: string;
    email: string;
    phone: string | null;
  };
};

type SponsorshipListItem = Sponsorship & {
  batch: {
    id: string;
    labName: string;
    contactName: string;
    email: string;
  };
  usages: Array<{
    registrationId: string | null;
    amountApplied: number;
  }>;
};

// ============================================================================
// List Sponsorships (Admin)
// ============================================================================

/**
 * List sponsorships for an event with pagination and filtering.
 */
export async function listSponsorships(
  eventId: string,
  query: ListSponsorshipsQuery,
): Promise<PaginatedResult<SponsorshipListItem>> {
  const { page, limit, status, search, sortBy, sortOrder } = query;

  const where: Prisma.SponsorshipWhereInput = { eventId };

  if (status) {
    where.status = status;
  }

  if (search) {
    where.OR = [
      { code: { contains: search, mode: "insensitive" } },
      { beneficiaryName: { contains: search, mode: "insensitive" } },
      { batch: { labName: { contains: search, mode: "insensitive" } } },
      { batch: { contactName: { contains: search, mode: "insensitive" } } },
    ];
  }

  // Build orderBy
  const orderBy: Prisma.SponsorshipOrderByWithRelationInput = {};
  if (sortBy === "beneficiaryName") {
    orderBy.beneficiaryName = sortOrder;
  } else if (sortBy === "totalAmount") {
    orderBy.totalAmount = sortOrder;
  } else {
    orderBy.createdAt = sortOrder;
  }

  const skip = getSkip({ page, limit });

  const [data, total] = await Promise.all([
    prisma.sponsorship.findMany({
      where,
      skip,
      take: limit,
      orderBy,
      include: {
        batch: {
          select: {
            id: true,
            labName: true,
            contactName: true,
            email: true,
          },
        },
        usages: {
          select: {
            registrationId: true,
            amountApplied: true,
          },
        },
      },
    }),
    prisma.sponsorship.count({ where }),
  ]);

  return paginate(data, total, { page, limit });
}

// ============================================================================
// Get Sponsorship by ID (Admin)
// ============================================================================

type SponsorshipByIdResult = Sponsorship & {
  batch: SponsorshipBatch;
  usages: Array<
    SponsorshipUsage & {
      registration: {
        id: string;
        email: string;
        firstName: string | null;
        lastName: string | null;
      } | null;
    }
  >;
  coveredAccessItems: Array<{ id: string; name: string; price: number }>;
};

/**
 * Get sponsorship details including batch info, usages, and resolved access items.
 */
export async function getSponsorshipById(
  id: string,
): Promise<SponsorshipByIdResult | null> {
  const sponsorship = await prisma.sponsorship.findUnique({
    where: { id },
    include: {
      batch: true,
      usages: {
        include: {
          registration: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      },
    },
  });

  if (!sponsorship) return null;

  // Resolve coveredAccessIds to full access item objects
  const coveredAccessItems =
    sponsorship.coveredAccessIds.length > 0
      ? await prisma.eventAccess.findMany({
          where: { id: { in: sponsorship.coveredAccessIds } },
          select: { id: true, name: true, price: true },
        })
      : [];

  return {
    ...sponsorship,
    coveredAccessItems,
  };
}

// ============================================================================
// Get Sponsorship by Code (Admin)
// ============================================================================

/**
 * Get sponsorship by code for a specific event.
 */
export async function getSponsorshipByCode(
  eventId: string,
  code: string,
): Promise<SponsorshipWithBatch | null> {
  return prisma.sponsorship.findFirst({
    where: { eventId, code },
    include: {
      batch: {
        select: {
          id: true,
          labName: true,
          contactName: true,
          email: true,
          phone: true,
        },
      },
    },
  });
}

// ============================================================================
// Update Sponsorship (Admin)
// ============================================================================

/**
 * Update sponsorship coverage, beneficiary info, or cancel it.
 */
export async function updateSponsorship(
  id: string,
  input: UpdateSponsorshipInput,
  performedBy?: string,
): Promise<SponsorshipByIdResult> {
  const sponsorship = await prisma.sponsorship.findUnique({
    where: { id },
    include: { usages: true },
  });

  if (!sponsorship) {
    throw new AppError(
      "Sponsorship not found",
      404,
      true,
      ErrorCodes.NOT_FOUND,
    );
  }

  // If cancelling, handle unlinking first
  if (input.status === "CANCELLED") {
    return cancelSponsorship(id, performedBy);
  }

  const updateData: Prisma.SponsorshipUpdateInput = {};

  if (input.beneficiaryName !== undefined)
    updateData.beneficiaryName = input.beneficiaryName;
  if (input.beneficiaryEmail !== undefined)
    updateData.beneficiaryEmail = input.beneficiaryEmail;
  if (input.beneficiaryPhone !== undefined)
    updateData.beneficiaryPhone = input.beneficiaryPhone;
  if (input.beneficiaryAddress !== undefined)
    updateData.beneficiaryAddress = input.beneficiaryAddress;
  if (input.coversBasePrice !== undefined)
    updateData.coversBasePrice = input.coversBasePrice;
  if (input.coveredAccessIds !== undefined)
    updateData.coveredAccessIds = input.coveredAccessIds;

  // Validate time overlaps if coveredAccessIds is being updated
  if (input.coveredAccessIds !== undefined) {
    const newCoveredAccessIds = input.coveredAccessIds;
    if (newCoveredAccessIds.length >= 2) {
      const accessItems = await prisma.eventAccess.findMany({
        where: {
          id: { in: newCoveredAccessIds },
          eventId: sponsorship.eventId,
          active: true,
        },
        select: {
          id: true,
          name: true,
          type: true,
          groupLabel: true,
          startsAt: true,
          endsAt: true,
        },
      });

      const timeErrors = validateCoveredAccessTimeOverlap(
        newCoveredAccessIds,
        accessItems.map((item) => ({
          id: item.id,
          name: item.name,
          type: item.type,
          groupLabel: item.groupLabel,
          startsAt: item.startsAt,
          endsAt: item.endsAt,
        })),
      );

      if (timeErrors.length > 0) {
        throw new AppError(
          `Time conflicts in covered access items: ${timeErrors.join("; ")}`,
          400,
          true,
          ErrorCodes.BAD_REQUEST,
          { timeConflicts: timeErrors },
        );
      }
    }
  }

  // Recalculate total amount if coverage changed
  const coversBasePrice = input.coversBasePrice ?? sponsorship.coversBasePrice;
  const coveredAccessIds =
    input.coveredAccessIds ?? sponsorship.coveredAccessIds;

  if (
    input.coversBasePrice !== undefined ||
    input.coveredAccessIds !== undefined
  ) {
    const totalAmount = await calculateSponsorshipTotal(
      prisma,
      sponsorship.eventId,
      coversBasePrice,
      coveredAccessIds,
    );
    updateData.totalAmount = totalAmount;
  }

  // Update sponsorship and recalculate in transaction
  await prisma.$transaction(async (tx) => {
    await tx.sponsorship.update({
      where: { id },
      data: updateData,
    });

    // If linked to registrations, recalculate applicable amounts
    if (sponsorship.usages.length > 0) {
      await recalculateUsageAmounts(tx, id);
    }

    // Audit log
    await tx.auditLog.create({
      data: {
        entityType: "Sponsorship",
        entityId: id,
        action: "UPDATE",
        changes: updateData as unknown as Prisma.InputJsonValue,
        performedBy: performedBy ?? "SYSTEM",
      },
    });
  });

  const result = await getSponsorshipById(id);
  if (!result) {
    throw new AppError(
      "Sponsorship not found after update",
      500,
      false,
      ErrorCodes.INTERNAL_ERROR,
    );
  }
  return result;
}

// ============================================================================
// Cancel Sponsorship (Admin)
// ============================================================================

/**
 * Cancel a sponsorship and unlink from all registrations.
 */
export async function cancelSponsorship(
  id: string,
  performedBy?: string,
): Promise<SponsorshipByIdResult> {
  const sponsorship = await prisma.sponsorship.findUnique({
    where: { id },
    include: { usages: { select: { registrationId: true } } },
  });

  if (!sponsorship) {
    throw new AppError(
      "Sponsorship not found",
      404,
      true,
      ErrorCodes.NOT_FOUND,
    );
  }

  await prisma.$transaction(async (tx) => {
    // Unlink from all registrations
    for (const usage of sponsorship.usages) {
      if (usage.registrationId) {
        await unlinkSponsorshipFromRegistrationInternal(
          tx,
          id,
          usage.registrationId,
        );
      }
    }

    // Set status to CANCELLED
    await tx.sponsorship.update({
      where: { id },
      data: { status: "CANCELLED" },
    });

    // Audit log for cancellation
    await tx.auditLog.create({
      data: {
        entityType: "Sponsorship",
        entityId: id,
        action: "CANCEL",
        changes: { status: { old: sponsorship.status, new: "CANCELLED" } },
        performedBy: performedBy ?? "SYSTEM",
      },
    });
  });

  const result = await getSponsorshipById(id);
  if (!result) {
    throw new AppError(
      "Sponsorship not found after cancellation",
      500,
      false,
      ErrorCodes.INTERNAL_ERROR,
    );
  }
  return result;
}

// ============================================================================
// Delete Sponsorship (Admin)
// ============================================================================

/**
 * Delete a sponsorship permanently.
 * Unlinks from registrations first if needed.
 */
export async function deleteSponsorship(
  id: string,
  performedBy?: string,
): Promise<void> {
  const sponsorship = await prisma.sponsorship.findUnique({
    where: { id },
    include: { usages: { select: { registrationId: true } } },
  });

  if (!sponsorship) {
    throw new AppError(
      "Sponsorship not found",
      404,
      true,
      ErrorCodes.NOT_FOUND,
    );
  }

  await prisma.$transaction(async (tx) => {
    // Unlink from all registrations first
    for (const usage of sponsorship.usages) {
      if (usage.registrationId) {
        await unlinkSponsorshipFromRegistrationInternal(
          tx,
          id,
          usage.registrationId,
        );
      }
    }

    // Audit log for deletion (before actual delete)
    await tx.auditLog.create({
      data: {
        entityType: "Sponsorship",
        entityId: id,
        action: "DELETE",
        changes: {
          beneficiaryEmail: sponsorship.beneficiaryEmail,
          code: sponsorship.code,
        },
        performedBy: performedBy ?? "SYSTEM",
      },
    });

    // Delete sponsorship (cascade will delete usages)
    await tx.sponsorship.delete({ where: { id } });
  });
}

// ============================================================================
// Sponsorship Stats (Admin)
// ============================================================================

export interface SponsorshipStats {
  total: number;
  totalAmount: number;
  pending: { count: number; amount: number };
  used: { count: number; amount: number };
  cancelled: { count: number; amount: number };
  currency: string;
}

/**
 * Get sponsorship statistics for an event.
 * Aggregates all sponsorships by status.
 */
export async function getSponsorshipStats(
  eventId: string,
): Promise<SponsorshipStats> {
  // Fetch event pricing for currency
  const pricing = await prisma.eventPricing.findUnique({
    where: { eventId },
    select: { currency: true },
  });
  const currency = pricing?.currency ?? "TND";

  // Group sponsorships by status and aggregate
  const grouped = await prisma.sponsorship.groupBy({
    by: ["status"],
    where: { eventId },
    _count: true,
    _sum: {
      totalAmount: true,
    },
  });

  // Initialize stats
  const stats: SponsorshipStats = {
    total: 0,
    totalAmount: 0,
    pending: { count: 0, amount: 0 },
    used: { count: 0, amount: 0 },
    cancelled: { count: 0, amount: 0 },
    currency,
  };

  // Populate stats from grouped results
  for (const group of grouped) {
    const count = group._count;
    const amount = group._sum.totalAmount ?? 0;

    stats.total += count;
    stats.totalAmount += amount;

    if (group.status === "PENDING") {
      stats.pending = { count, amount };
    } else if (group.status === "USED") {
      stats.used = { count, amount };
    } else if (group.status === "CANCELLED") {
      stats.cancelled = { count, amount };
    }
  }

  return stats;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get client ID for a sponsorship (for permission checks).
 */
export async function getSponsorshipClientId(
  id: string,
): Promise<string | null> {
  const sponsorship = await prisma.sponsorship.findUnique({
    where: { id },
    include: { event: { select: { clientId: true } } },
  });
  return sponsorship?.event.clientId ?? null;
}
