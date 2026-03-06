import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors.js";
import { ErrorCodes } from "@shared/errors.js";
import { logger } from "@shared/utils/logger.js";
import {
  calculateApplicableAmount,
  capSponsorshipAmount,
  detectCoverageOverlap,
  calculateTotalSponsorshipAmount,
  determineSponsorshipStatus,
  type ExistingUsage,
} from "./sponsorships.utils.js";
import { parsePriceBreakdown } from "@registrations";
import { queueSponsorshipAppliedEmail } from "./sponsorships-query.service.js";

// ============================================================================
// Types
// ============================================================================

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

export interface LinkSponsorshipResult {
  skipped: false;
  usage: {
    id: string;
    sponsorshipId: string;
    amountApplied: number;
  };
  registration: {
    totalAmount: number;
    sponsorshipAmount: number;
    amountDue: number;
  };
  warnings: string[];
}

export interface LinkSponsorshipSkippedResult {
  skipped: true;
  reason: string;
}

// ============================================================================
// Link Sponsorship to Registration (Admin)
// ============================================================================

type SponsorshipForLinking = Awaited<
  ReturnType<typeof prisma.sponsorship.findUnique>
> & {
  usages: Array<{
    sponsorshipId: string;
    sponsorship: { code: string; coversBasePrice: boolean; coveredAccessIds: string[] };
  }>;
};

type RegistrationForLinking = NonNullable<
  Awaited<ReturnType<typeof prisma.registration.findUnique>>
> & {
  sponsorshipUsages: Array<{
    sponsorshipId: string;
    sponsorship: { code: string; coversBasePrice: boolean; coveredAccessIds: string[] };
  }>;
};

async function validateSponsorshipForLinking(
  sponsorshipId: string,
  registrationId: string,
): Promise<{ sponsorship: NonNullable<SponsorshipForLinking>; registration: RegistrationForLinking }> {
  const sponsorship = await prisma.sponsorship.findUnique({
    where: { id: sponsorshipId },
    include: {
      usages: {
        include: {
          sponsorship: {
            select: { code: true, coversBasePrice: true, coveredAccessIds: true },
          },
        },
      },
    },
  });
  if (!sponsorship)
    throw new AppError("Sponsorship not found", 404, true, ErrorCodes.NOT_FOUND);

  if (sponsorship.status === "CANCELLED") {
    throw new AppError(
      "Cannot link a cancelled sponsorship",
      400,
      true,
      ErrorCodes.BAD_REQUEST,
      { code: "SPONSORSHIP_CANCELLED" },
    );
  }

  const registration = await prisma.registration.findUnique({
    where: { id: registrationId },
    select: {
      id: true,
      eventId: true,
      totalAmount: true,
      baseAmount: true,
      accessTypeIds: true,
      priceBreakdown: true,
      sponsorshipAmount: true,
      sponsorshipUsages: {
        include: {
          sponsorship: {
            select: { code: true, coversBasePrice: true, coveredAccessIds: true },
          },
        },
      },
    },
  });
  if (!registration)
    throw new AppError(
      "Registration not found",
      404,
      true,
      ErrorCodes.REGISTRATION_NOT_FOUND,
    );

  if (sponsorship.eventId !== registration.eventId) {
    throw new AppError(
      "Sponsorship and registration must be for the same event",
      400,
      true,
      ErrorCodes.BAD_REQUEST,
    );
  }

  const existingLink = await prisma.sponsorshipUsage.findUnique({
    where: { sponsorshipId_registrationId: { sponsorshipId, registrationId } },
  });
  if (existingLink) {
    throw new AppError(
      "Sponsorship is already linked to this registration",
      409,
      true,
      ErrorCodes.CONFLICT,
      { code: "SPONSORSHIP_ALREADY_LINKED" },
    );
  }

  return { sponsorship, registration: registration as unknown as RegistrationForLinking };
}

function calculateLinkingAmount(
  sponsorship: NonNullable<SponsorshipForLinking>,
  registration: RegistrationForLinking,
): { cappedAmount: number; overlapWarnings: string[] } | null {
  const existingUsages: ExistingUsage[] = registration.sponsorshipUsages.map(
    (u) => ({ sponsorshipId: u.sponsorshipId, sponsorship: u.sponsorship }),
  );

  // Overlap detection warnings are intentional and non-blocking.
  // Admins may intentionally link multiple sponsorships that cover the same items.
  // The warnings provide visibility without preventing the operation.
  const overlapWarnings = detectCoverageOverlap(existingUsages, {
    coversBasePrice: sponsorship.coversBasePrice,
    coveredAccessIds: sponsorship.coveredAccessIds,
    totalAmount: sponsorship.totalAmount,
  });

  const priceBreakdown = parsePriceBreakdown(registration.priceBreakdown);
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

  const cappedAmount = capSponsorshipAmount(
    applicableAmount,
    registration.sponsorshipAmount,
    registration.totalAmount,
  );

  if (cappedAmount === 0) return null;

  return { cappedAmount, overlapWarnings };
}

async function performLinkingTransaction(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  sponsorship: NonNullable<SponsorshipForLinking>,
  registration: RegistrationForLinking,
  cappedAmount: number,
  adminUserId: string,
  warnings: string[],
): Promise<LinkSponsorshipResult> {
  const sponsorshipId = sponsorship.id;
  const registrationId = registration.id;

  const usage = await tx.sponsorshipUsage.create({
    data: { sponsorshipId, registrationId, amountApplied: cappedAmount, appliedBy: adminUserId },
  });

  // Update sponsorship status to USED (atomic with status check to prevent race)
  const statusUpdate = await tx.sponsorship.updateMany({
    where: { id: sponsorshipId, status: { not: "CANCELLED" } },
    data: { status: "USED" },
  });

  if (statusUpdate.count === 0) {
    throw new AppError(
      "Sponsorship cannot be linked (may be cancelled or already processing)",
      409,
      true,
      ErrorCodes.SPONSORSHIP_STATUS_CONFLICT,
    );
  }

  const allUsages = await tx.sponsorshipUsage.findMany({
    where: { registrationId },
    select: { amountApplied: true },
  });
  const newSponsorshipAmount = calculateTotalSponsorshipAmount(allUsages);

  await tx.registration.update({
    where: { id: registrationId },
    data: { sponsorshipAmount: newSponsorshipAmount },
  });

  await tx.auditLog.create({
    data: {
      entityType: "Sponsorship",
      entityId: sponsorshipId,
      action: "LINK",
      changes: {
        registrationId: { old: null, new: registrationId },
        amountApplied: { old: null, new: cappedAmount },
      },
      performedBy: adminUserId ?? "SYSTEM",
    },
  });

  return {
    skipped: false as const,
    usage: { id: usage.id, sponsorshipId: usage.sponsorshipId, amountApplied: usage.amountApplied },
    registration: {
      totalAmount: registration.totalAmount,
      sponsorshipAmount: newSponsorshipAmount,
      amountDue: Math.max(0, registration.totalAmount - newSponsorshipAmount),
    },
    warnings,
  };
}

/**
 * Link a sponsorship to a registration by sponsorship ID.
 */
export async function linkSponsorshipToRegistration(
  sponsorshipId: string,
  registrationId: string,
  adminUserId: string,
): Promise<LinkSponsorshipResult | LinkSponsorshipSkippedResult> {
  const { sponsorship, registration } = await validateSponsorshipForLinking(
    sponsorshipId,
    registrationId,
  );

  const calculated = calculateLinkingAmount(sponsorship, registration);

  if (calculated === null) {
    logger.warn(
      { sponsorshipId, registrationId, currentSponsorshipAmount: registration.sponsorshipAmount },
      "Skipping sponsorship link - registration is fully sponsored or coverage does not apply",
    );
    return {
      skipped: true,
      reason:
        "Sponsorship coverage does not apply to this registration (no overlap between sponsored items and registration selections, or registration is fully sponsored)",
    };
  }

  const { cappedAmount, overlapWarnings } = calculated;

  const result = await prisma.$transaction((tx) =>
    performLinkingTransaction(tx, sponsorship, registration, cappedAmount, adminUserId, overlapWarnings),
  );

  await queueSponsorshipAppliedEmail(sponsorshipId, registrationId, sponsorship.eventId);

  return result;
}

// ============================================================================
// Link Sponsorship by Code (Admin)
// ============================================================================

/**
 * Link a sponsorship to a registration by code.
 */
export async function linkSponsorshipByCode(
  registrationId: string,
  code: string,
  adminUserId: string,
): Promise<LinkSponsorshipResult | LinkSponsorshipSkippedResult> {
  const registration = await prisma.registration.findUnique({
    where: { id: registrationId },
    select: { eventId: true },
  });
  if (!registration)
    throw new AppError(
      "Registration not found",
      404,
      true,
      ErrorCodes.REGISTRATION_NOT_FOUND,
    );

  const sponsorship = await prisma.sponsorship.findFirst({
    where: { eventId: registration.eventId, code },
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

  if (!sponsorship) {
    throw new AppError(
      `Code ${code} not found for this event`,
      404,
      true,
      ErrorCodes.NOT_FOUND,
      { code: "SPONSORSHIP_NOT_FOUND" },
    );
  }

  return linkSponsorshipToRegistration(
    sponsorship.id,
    registrationId,
    adminUserId,
  );
}

// ============================================================================
// Unlink Sponsorship from Registration (Admin)
// ============================================================================

/**
 * Unlink a sponsorship from a registration.
 */
export async function unlinkSponsorshipFromRegistration(
  sponsorshipId: string,
  registrationId: string,
): Promise<void> {
  await unlinkSponsorshipFromRegistrationInternal(
    prisma,
    sponsorshipId,
    registrationId,
  );
}

/**
 * Internal unlink function that works with transaction client.
 */
export async function unlinkSponsorshipFromRegistrationInternal(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  sponsorshipId: string,
  registrationId: string,
): Promise<void> {
  const usage = await tx.sponsorshipUsage.findUnique({
    where: {
      sponsorshipId_registrationId: { sponsorshipId, registrationId },
    },
  });
  if (!usage)
    throw new AppError(
      "Sponsorship is not linked to this registration",
      404,
      true,
      ErrorCodes.NOT_FOUND,
    );

  // Audit log for unlink (before actual delete)
  await tx.auditLog.create({
    data: {
      entityType: "Sponsorship",
      entityId: sponsorshipId,
      action: "UNLINK",
      changes: {
        registrationId: { old: registrationId, new: null },
        amountApplied: { old: usage.amountApplied, new: 0 },
      },
      performedBy: "SYSTEM",
    },
  });

  // Delete the usage
  await tx.sponsorshipUsage.delete({
    where: { id: usage.id },
  });

  // Recalculate registration's sponsorship amount
  const remainingUsages = await tx.sponsorshipUsage.findMany({
    where: { registrationId },
    select: { amountApplied: true },
  });

  const regForCap = await tx.registration.findUnique({
    where: { id: registrationId },
    select: { totalAmount: true },
  });

  const rawSponsorshipAmount = calculateTotalSponsorshipAmount(remainingUsages);
  const newSponsorshipAmount = Math.min(
    rawSponsorshipAmount,
    regForCap?.totalAmount ?? rawSponsorshipAmount,
  );

  await tx.registration.update({
    where: { id: registrationId },
    data: { sponsorshipAmount: newSponsorshipAmount },
  });

  // Check if sponsorship has any remaining usages
  const sponsorshipUsageCount = await tx.sponsorshipUsage.count({
    where: { sponsorshipId },
  });

  // Update sponsorship status if needed
  const sponsorship = await tx.sponsorship.findUnique({
    where: { id: sponsorshipId },
    select: { status: true },
  });

  if (sponsorship) {
    const newStatus = determineSponsorshipStatus(
      { status: sponsorship.status },
      sponsorshipUsageCount,
    );

    if (newStatus !== sponsorship.status) {
      await tx.sponsorship.update({
        where: { id: sponsorshipId },
        data: { status: newStatus },
      });
    }
  }
}

/**
 * Clean up all sponsorship usages for a registration (called during registration deletion).
 * Unlinks all sponsorships, reverting their status to PENDING if no other usages exist.
 */
export async function cleanupSponsorshipsForRegistration(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  registrationId: string,
): Promise<void> {
  // Find all sponsorship usages for this registration
  const sponsorshipUsages = await tx.sponsorshipUsage.findMany({
    where: { registrationId },
    select: { sponsorshipId: true },
  });

  // Unlink each sponsorship
  for (const usage of sponsorshipUsages) {
    await unlinkSponsorshipFromRegistrationInternal(
      tx,
      usage.sponsorshipId,
      registrationId,
    );
  }
}

