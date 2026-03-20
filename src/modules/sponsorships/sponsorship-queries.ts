import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import {
  paginate,
  getSkip,
  type PaginatedResult,
} from "@shared/utils/pagination.js";
import {
  calculateApplicableAmount,
  detectCoverageOverlap,
  type RegistrationForCalculation,
  type ExistingUsage,
} from "./sponsorships.utils.js";
import type { ListSponsorshipsQuery } from "./sponsorships.schema.js";
import type {
  Prisma,
  Sponsorship,
  SponsorshipBatch,
  SponsorshipUsage,
} from "@/generated/prisma/client.js";

// ============================================================================
// Types
// ============================================================================

export type SponsorshipWithBatch = Sponsorship & {
  batch: {
    id: string;
    labName: string;
    contactName: string;
    email: string;
    phone: string | null;
  };
};

export type SponsorshipWithUsages = Sponsorship & {
  batch: SponsorshipBatch;
  usages: Array<
    SponsorshipUsage & {
      registration: {
        id: string;
        email: string;
        firstName: string | null;
        lastName: string | null;
      };
    }
  >;
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

export interface AvailableSponsorship {
  id: string;
  code: string;
  beneficiaryName: string;
  beneficiaryEmail: string;
  totalAmount: number;
  coversBasePrice: boolean;
  coveredAccessIds: string[];
  batch: {
    labName: string;
  };
  applicableAmount: number;
  conflicts: string[];
}

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

/**
 * Get sponsorship details including batch info, usages, and resolved access items.
 */
export async function getSponsorshipById(id: string) {
  const sponsorship = await prisma.sponsorship.findUnique({
    where: { id },
    include: {
      event: {
        select: { clientId: true },
      },
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
// Get Available Sponsorships (Admin)
// ============================================================================

/**
 * Get sponsorships available to link to a registration.
 * Returns PENDING sponsorships with calculated applicable amounts.
 */
export async function getAvailableSponsorships(
  eventId: string,
  registrationId: string,
): Promise<AvailableSponsorship[]> {
  const registration = await prisma.registration.findUnique({
    where: { id: registrationId },
    select: {
      id: true,
      eventId: true,
      totalAmount: true,
      baseAmount: true,
      accessTypeIds: true,
      priceBreakdown: true,
      sponsorshipUsages: {
        include: {
          sponsorship: {
            select: {
              code: true,
              coversBasePrice: true,
              coveredAccessIds: true,
            },
          },
        },
      },
    },
  });

  if (!registration) {
    throw new AppError(
      "Registration not found",
      404,
      ErrorCodes.REGISTRATION_NOT_FOUND,
    );
  }

  if (registration.eventId !== eventId) {
    throw new AppError(
      "Registration does not belong to this event",
      400,
      ErrorCodes.BAD_REQUEST,
    );
  }

  // Get PENDING sponsorships for this event
  const sponsorships = await prisma.sponsorship.findMany({
    where: {
      eventId,
      status: "PENDING",
    },
    include: {
      batch: {
        select: { labName: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // Prepare existing usages for overlap detection
  const existingUsages: ExistingUsage[] = registration.sponsorshipUsages.map(
    (u) => ({
      sponsorshipId: u.sponsorshipId,
      sponsorship: u.sponsorship,
    }),
  );

  // Calculate applicable amount and conflicts for each
  const priceBreakdown =
    registration.priceBreakdown as RegistrationForCalculation["priceBreakdown"];

  return sponsorships.map((sponsorship) => {
    const applicableAmount = calculateApplicableAmount(
      {
        coversBasePrice: sponsorship.coversBasePrice,
        coveredAccessIds: sponsorship.coveredAccessIds,
        totalAmount: sponsorship.totalAmount,
      },
      {
        totalAmount: registration.totalAmount,
        baseAmount: registration.baseAmount,
        accessTypeIds: registration.accessTypeIds,
        priceBreakdown,
      },
    );

    const conflicts = detectCoverageOverlap(existingUsages, {
      coversBasePrice: sponsorship.coversBasePrice,
      coveredAccessIds: sponsorship.coveredAccessIds,
      totalAmount: sponsorship.totalAmount,
    });

    return {
      id: sponsorship.id,
      code: sponsorship.code,
      beneficiaryName: sponsorship.beneficiaryName,
      beneficiaryEmail: sponsorship.beneficiaryEmail,
      totalAmount: sponsorship.totalAmount,
      coversBasePrice: sponsorship.coversBasePrice,
      coveredAccessIds: sponsorship.coveredAccessIds,
      batch: sponsorship.batch,
      applicableAmount,
      conflicts,
    };
  });
}

// ============================================================================
// Get Linked Sponsorships for Registration (Admin)
// ============================================================================

/**
 * Get all sponsorships linked to a registration.
 */
export async function getLinkedSponsorships(registrationId: string) {
  const usages = await prisma.sponsorshipUsage.findMany({
    where: { registrationId },
    include: {
      sponsorship: {
        include: {
          batch: {
            select: {
              id: true,
              labName: true,
              contactName: true,
              email: true,
            },
          },
        },
      },
    },
  });

  // Transform to the expected format
  return usages.map((usage) => ({
    id: usage.sponsorship.id,
    code: usage.sponsorship.code,
    status: usage.sponsorship.status,
    beneficiaryName: usage.sponsorship.beneficiaryName,
    beneficiaryEmail: usage.sponsorship.beneficiaryEmail,
    coversBasePrice: usage.sponsorship.coversBasePrice,
    coveredAccessIds: usage.sponsorship.coveredAccessIds,
    totalAmount: usage.sponsorship.totalAmount,
    batch: usage.sponsorship.batch,
    usage: {
      id: usage.id,
      amountApplied: usage.amountApplied,
      appliedAt: usage.appliedAt,
    },
  }));
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
