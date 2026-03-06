import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors.js";
import { ErrorCodes } from "@shared/errors.js";
import { logger } from "@shared/utils/logger.js";
import {
  calculateApplicableAmount,
  detectCoverageOverlap,
  type ExistingUsage,
} from "./sponsorships.utils.js";
import { queueSponsorshipEmail, buildLinkedSponsorshipContext } from "@email";
import { parsePriceBreakdown } from "@registrations";
import type { AvailableSponsorship } from "./sponsorships-linking.service.js";

// ============================================================================
// Types
// ============================================================================

type RegistrationForAvailable = {
  id: string;
  eventId: string;
  totalAmount: number;
  baseAmount: number;
  accessTypeIds: string[];
  priceBreakdown: unknown;
  sponsorshipUsages: Array<{
    sponsorshipId: string;
    sponsorship: { code: string; coversBasePrice: boolean; coveredAccessIds: string[] };
  }>;
};

// ============================================================================
// Get Available Sponsorships (Admin)
// ============================================================================

async function fetchRegistrationForAvailable(
  registrationId: string,
  eventId: string,
): Promise<RegistrationForAvailable> {
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
            select: { code: true, coversBasePrice: true, coveredAccessIds: true },
          },
        },
      },
    },
  });
  if (!registration)
    throw new AppError("Registration not found", 404, true, ErrorCodes.REGISTRATION_NOT_FOUND);
  if (registration.eventId !== eventId) {
    throw new AppError("Registration does not belong to this event", 400, true, ErrorCodes.BAD_REQUEST);
  }
  return registration;
}

function mapSponsorshipToAvailable(
  sponsorship: {
    id: string;
    code: string;
    beneficiaryName: string;
    beneficiaryEmail: string;
    totalAmount: number;
    coversBasePrice: boolean;
    coveredAccessIds: string[];
    batch: { labName: string };
  },
  registration: RegistrationForAvailable,
  existingUsages: ExistingUsage[],
  priceBreakdown: ReturnType<typeof parsePriceBreakdown>,
): AvailableSponsorship {
  const applicableAmount = calculateApplicableAmount(
    { coversBasePrice: sponsorship.coversBasePrice, coveredAccessIds: sponsorship.coveredAccessIds, totalAmount: sponsorship.totalAmount },
    { totalAmount: registration.totalAmount, baseAmount: registration.baseAmount, accessTypeIds: registration.accessTypeIds, priceBreakdown },
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
}

/**
 * Get sponsorships available to link to a registration.
 * Returns PENDING sponsorships with calculated applicable amounts.
 */
export async function getAvailableSponsorships(
  eventId: string,
  registrationId: string,
): Promise<AvailableSponsorship[]> {
  const registration = await fetchRegistrationForAvailable(registrationId, eventId);

  const sponsorships = await prisma.sponsorship.findMany({
    where: { eventId, status: "PENDING" },
    include: { batch: { select: { labName: true } } },
    orderBy: { createdAt: "desc" },
  });

  const existingUsages: ExistingUsage[] = registration.sponsorshipUsages.map(
    (u) => ({ sponsorshipId: u.sponsorshipId, sponsorship: u.sponsorship }),
  );
  const priceBreakdown = parsePriceBreakdown(registration.priceBreakdown);

  return sponsorships.map((s) => mapSponsorshipToAvailable(s, registration, existingUsages, priceBreakdown));
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
// Recalculate Usage Amounts
// ============================================================================

/**
 * Recalculate usage amounts for all usages of a sponsorship.
 * Called after sponsorship coverage is updated.
 */
export async function recalculateUsageAmounts(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  sponsorshipId: string,
): Promise<void> {
  const sponsorship = await tx.sponsorship.findUnique({
    where: { id: sponsorshipId },
    include: {
      usages: {
        include: {
          registration: {
            select: {
              id: true,
              totalAmount: true,
              baseAmount: true,
              accessTypeIds: true,
              priceBreakdown: true,
            },
          },
        },
      },
    },
  });

  if (!sponsorship) return;

  for (const usage of sponsorship.usages) {
    if (!usage.registration) continue;

    const priceBreakdown = parsePriceBreakdown(
      usage.registration.priceBreakdown,
    );

    const newAmount = calculateApplicableAmount(
      {
        coversBasePrice: sponsorship.coversBasePrice,
        coveredAccessIds: sponsorship.coveredAccessIds,
        totalAmount: sponsorship.totalAmount,
      },
      {
        totalAmount: usage.registration.totalAmount,
        baseAmount: usage.registration.baseAmount,
        accessTypeIds: usage.registration.accessTypeIds,
        priceBreakdown,
      },
    );

    const oldAmount = usage.amountApplied;
    const delta = newAmount - oldAmount;

    await tx.sponsorshipUsage.update({
      where: { id: usage.id },
      data: { amountApplied: newAmount },
    });

    const registrationId = usage.registration.id;
    await tx.$executeRaw`
      UPDATE "registrations"
      SET sponsorship_amount = GREATEST(0, LEAST(total_amount, sponsorship_amount + ${delta}))
      WHERE id = ${registrationId}
    `;
  }
}

// ============================================================================
// Email helpers for sponsorship link notification
// ============================================================================

async function fetchAppliedEmailData(
  sponsorshipId: string,
  registrationId: string,
  eventId: string,
) {
  const [sponsorshipWithBatch, registrationDetails, event, pricing] =
    await Promise.all([
      prisma.sponsorship.findUnique({
        where: { id: sponsorshipId },
        include: { batch: { select: { labName: true, contactName: true, email: true } } },
      }),
      prisma.registration.findUnique({
        where: { id: registrationId },
        select: {
          id: true, email: true, firstName: true, lastName: true, phone: true,
          totalAmount: true, sponsorshipAmount: true, linkBaseUrl: true, editToken: true,
        },
      }),
      prisma.event.findUnique({
        where: { id: eventId },
        select: { name: true, slug: true, startDate: true, location: true, client: { select: { name: true } } },
      }),
      prisma.eventPricing.findUnique({ where: { eventId }, select: { basePrice: true, currency: true } }),
    ]);

  const accessItems =
    sponsorshipWithBatch && sponsorshipWithBatch.coveredAccessIds.length > 0
      ? await prisma.eventAccess.findMany({
          where: { id: { in: sponsorshipWithBatch.coveredAccessIds } },
          select: { id: true, name: true, price: true },
        })
      : [];

  return { sponsorshipWithBatch, registrationDetails, event, pricing, accessItems };
}

async function sendAppliedEmailIfConfigured(
  sponsorshipWithBatch: NonNullable<Awaited<ReturnType<typeof prisma.sponsorship.findUnique>> & { batch: { labName: string; contactName: string; email: string } }>,
  registrationDetails: { id: string; email: string; firstName: string | null; lastName: string | null; phone: string | null; totalAmount: number; sponsorshipAmount: number; linkBaseUrl: string | null; editToken: string | null },
  event: { name: string; slug: string; startDate: Date; location: string | null; client: { name: string } },
  pricing: { basePrice: number; currency: string } | null,
  accessItems: Array<{ id: string; name: string; price: number }>,
  eventId: string,
  registrationId: string,
): Promise<void> {
  const currency = pricing?.currency ?? "TND";
  const context = buildLinkedSponsorshipContext({
    sponsorship: {
      code: sponsorshipWithBatch.code,
      beneficiaryName: sponsorshipWithBatch.beneficiaryName,
      coversBasePrice: sponsorshipWithBatch.coversBasePrice,
      coveredAccessIds: sponsorshipWithBatch.coveredAccessIds,
      totalAmount: sponsorshipWithBatch.totalAmount,
      batch: { labName: sponsorshipWithBatch.batch.labName, contactName: sponsorshipWithBatch.batch.contactName, email: sponsorshipWithBatch.batch.email },
    },
    registration: registrationDetails,
    event,
    pricing: pricing ? { basePrice: pricing.basePrice } : null,
    accessItems,
    currency,
  });
  const appliedEmailQueued = await queueSponsorshipEmail("SPONSORSHIP_APPLIED", eventId, {
    recipientEmail: registrationDetails.email,
    recipientName: registrationDetails.firstName || sponsorshipWithBatch.beneficiaryName,
    context,
    registrationId: registrationDetails.id,
  });
  if (!appliedEmailQueued) {
    logger.warn({ trigger: "SPONSORSHIP_APPLIED", eventId, registrationId }, "No email template configured - doctor will not receive sponsorship notification");
  }
}

/**
 * Queue SPONSORSHIP_APPLIED email after a sponsorship is linked to a registration.
 */
export async function queueSponsorshipAppliedEmail(
  sponsorshipId: string,
  registrationId: string,
  eventId: string,
): Promise<void> {
  try {
    const { sponsorshipWithBatch, registrationDetails, event, pricing, accessItems } =
      await fetchAppliedEmailData(sponsorshipId, registrationId, eventId);

    if (sponsorshipWithBatch && registrationDetails && event) {
      await sendAppliedEmailIfConfigured(
        sponsorshipWithBatch as NonNullable<typeof sponsorshipWithBatch> & { batch: { labName: string; contactName: string; email: string } },
        registrationDetails,
        event,
        pricing ?? null,
        accessItems,
        eventId,
        registrationId,
      );
    }
  } catch (emailError) {
    logger.error(
      { error: emailError, sponsorshipId, registrationId },
      "Failed to queue SPONSORSHIP_APPLIED email",
    );
  }
}
