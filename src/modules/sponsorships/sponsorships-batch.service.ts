import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors.js";
import { ErrorCodes } from "@shared/errors.js";
import { logger } from "@shared/utils/logger.js";
import {
  generateUniqueCode,
  calculateSponsorshipTotal,
  calculateApplicableAmount,
  capSponsorshipAmount,
  detectCoverageOverlap,
  validateCoveredAccessTimeOverlap,
} from "./sponsorships.utils.js";
import { parsePriceBreakdown } from "@registrations";
import type {
  BeneficiaryInput,
  LinkedBeneficiaryInput,
  SponsorInfo,
} from "./sponsorships.schema.js";

// Local type matching the inlined CreateSponsorshipBatchSchema in public routes
type CreateSponsorshipBatchInput = {
  sponsor: SponsorInfo;
  customFields?: Record<string, unknown>;
  beneficiaries?: BeneficiaryInput[];
  linkedBeneficiaries?: LinkedBeneficiaryInput[];
};
import type { Prisma, Sponsorship } from "@/generated/prisma/client.js";
import {
  queueSponsorshipEmail,
  buildBatchEmailContext,
  buildLinkedSponsorshipContext,
} from "@email";

// ============================================================================
// Types
// ============================================================================

export interface CreateBatchResult {
  batchId: string;
  count: number;
  skippedCount: number;
}

// ============================================================================
// Create Sponsorship Batch (Public form submission)
// ============================================================================

/**
 * Create a sponsorship batch with N sponsorships.
 * Supports two modes:
 * - CODE mode: beneficiaries array, creates PENDING sponsorships with codes
 * - LINKED_ACCOUNT mode: linkedBeneficiaries array, creates USED sponsorships auto-linked to registrations
 */
export async function createSponsorshipBatch(
  eventId: string,
  formId: string,
  input: CreateSponsorshipBatchInput,
): Promise<CreateBatchResult> {
  const { sponsor, customFields, beneficiaries, linkedBeneficiaries } = input;

  // Determine mode
  const isLinkedMode = (linkedBeneficiaries?.length ?? 0) > 0;
  const beneficiaryList = isLinkedMode
    ? linkedBeneficiaries!
    : (beneficiaries ?? []);

  // Check for duplicate emails within CODE mode batch
  if (!isLinkedMode && beneficiaries) {
    const emails = beneficiaries.map((b) => b.email.toLowerCase());
    const duplicates = emails.filter((e, i) => emails.indexOf(e) !== i);
    if (duplicates.length > 0) {
      throw new AppError(
        `Duplicate beneficiary emails: ${[...new Set(duplicates)].join(", ")}`,
        400,
        true,
        ErrorCodes.BAD_REQUEST,
        { duplicateEmails: [...new Set(duplicates)] },
      );
    }
  }

  // Check for duplicate registrationIds within LINKED_ACCOUNT mode batch
  if (isLinkedMode && linkedBeneficiaries) {
    const regIds = linkedBeneficiaries.map((b) => b.registrationId);
    const duplicates = regIds.filter((id, i) => regIds.indexOf(id) !== i);
    if (duplicates.length > 0) {
      throw new AppError(
        `Duplicate registration IDs in batch: ${[...new Set(duplicates)].join(", ")}`,
        400,
        true,
        ErrorCodes.BAD_REQUEST,
        { duplicateRegistrationIds: [...new Set(duplicates)] },
      );
    }
  }

  // Verify event exists and get details for email context
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      name: true,
      slug: true,
      status: true,
      startDate: true,
      location: true,
      client: { select: { name: true } },
    },
  });

  if (!event) {
    throw new AppError("Event not found", 404, true, ErrorCodes.NOT_FOUND);
  }

  // Verify form exists and belongs to event
  const form = await prisma.form.findFirst({
    where: { id: formId, eventId, type: "SPONSOR" },
    select: { id: true },
  });

  if (!form) {
    throw new AppError(
      "Sponsor form not found for this event",
      404,
      true,
      ErrorCodes.NOT_FOUND,
    );
  }

  // Get pricing for currency and base price
  const pricing = await prisma.eventPricing.findUnique({
    where: { eventId },
    select: { basePrice: true, currency: true },
  });
  const currency = pricing?.currency ?? "TND";

  // Validate all covered access IDs exist and belong to event
  const allAccessIds = new Set<string>();
  for (const beneficiary of beneficiaryList) {
    for (const accessId of beneficiary.coveredAccessIds) {
      allAccessIds.add(accessId);
    }
  }

  // Get access items for validation and email context
  let accessItems: Array<{
    id: string;
    name: string;
    price: number;
    type: string;
    groupLabel: string | null;
    startsAt: Date | null;
    endsAt: Date | null;
  }> = [];
  if (allAccessIds.size > 0) {
    accessItems = await prisma.eventAccess.findMany({
      where: {
        id: { in: Array.from(allAccessIds) },
        eventId,
        active: true,
      },
      select: {
        id: true,
        name: true,
        price: true,
        type: true,
        groupLabel: true,
        startsAt: true,
        endsAt: true,
      },
    });

    const validAccessIds = new Set(accessItems.map((a) => a.id));
    const invalidIds = Array.from(allAccessIds).filter(
      (id) => !validAccessIds.has(id),
    );

    if (invalidIds.length > 0) {
      throw new AppError(
        `Invalid access items: ${invalidIds.join(", ")}`,
        400,
        true,
        ErrorCodes.BAD_REQUEST,
        { invalidAccessIds: invalidIds },
      );
    }

    // Validate time overlaps within each beneficiary's covered access items
    const overlapErrors: string[] = [];
    beneficiaryList.forEach((beneficiary, index) => {
      if (beneficiary.coveredAccessIds.length >= 2) {
        const errors = validateCoveredAccessTimeOverlap(
          beneficiary.coveredAccessIds,
          accessItems.map((item) => ({
            id: item.id,
            name: item.name,
            type: item.type,
            groupLabel: item.groupLabel,
            startsAt: item.startsAt,
            endsAt: item.endsAt,
          })),
        );
        for (const error of errors) {
          overlapErrors.push(`Beneficiary #${index + 1}: ${error}`);
        }
      }
    });

    if (overlapErrors.length > 0) {
      throw new AppError(
        `Time conflicts in covered access items: ${overlapErrors.join("; ")}`,
        400,
        true,
        ErrorCodes.BAD_REQUEST,
        { timeConflicts: overlapErrors },
      );
    }
  }

  // For LINKED_ACCOUNT mode: validate registrations
  const registrations: Map<
    string,
    {
      id: string;
      email: string;
      firstName: string | null;
      lastName: string | null;
      phone: string | null;
      totalAmount: number;
      sponsorshipAmount: number;
      baseAmount: number;
      accessTypeIds: string[];
      priceBreakdown: unknown;
      linkBaseUrl: string | null;
      editToken: string | null;
    }
  > = new Map();

  if (isLinkedMode) {
    const registrationIds = linkedBeneficiaries!.map((b) => b.registrationId);
    const foundRegistrations = await prisma.registration.findMany({
      where: {
        id: { in: registrationIds },
        eventId,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        totalAmount: true,
        sponsorshipAmount: true,
        baseAmount: true,
        accessTypeIds: true,
        priceBreakdown: true,
        linkBaseUrl: true,
        editToken: true,
      },
    });

    // Check all registrations were found
    const foundIds = new Set(foundRegistrations.map((r) => r.id));
    const missingIds = registrationIds.filter((id) => !foundIds.has(id));
    if (missingIds.length > 0) {
      throw new AppError(
        `Registrations not found: ${missingIds.join(", ")}`,
        404,
        true,
        ErrorCodes.NOT_FOUND,
        { missingRegistrationIds: missingIds },
      );
    }

    // Build map for quick lookup
    for (const reg of foundRegistrations) {
      registrations.set(reg.id, reg);
    }
  }

  // Create batch and sponsorships in a transaction
  const result = await prisma.$transaction(async (tx) => {
    // Create the batch
    const batch = await tx.sponsorshipBatch.create({
      data: {
        eventId,
        formId,
        labName: sponsor.labName,
        contactName: sponsor.contactName,
        email: sponsor.email,
        phone: sponsor.phone ?? null,
        formData: {
          sponsor,
          customFields: customFields ?? {},
        } as Prisma.InputJsonValue,
      },
    });

    // Create sponsorships
    const createdSponsorships: Array<
      Sponsorship & { linkedRegistrationId?: string }
    > = [];

    // Track how many beneficiaries were skipped due to zero cap
    let skippedCount = 0;

    // Track cumulative sponsorship amounts per registration (for capping within batch)
    const registrationSponsorshipAmounts = new Map<string, number>();

    if (isLinkedMode) {
      // LINKED_ACCOUNT mode
      for (const linked of linkedBeneficiaries!) {
        const registration = registrations.get(linked.registrationId)!;

        // Get or initialize cumulative sponsorship amount for this registration
        if (!registrationSponsorshipAmounts.has(linked.registrationId)) {
          registrationSponsorshipAmounts.set(
            linked.registrationId,
            registration.sponsorshipAmount,
          );
        }

        // Fetch existing usages for overlap detection
        const existingUsages = await tx.sponsorshipUsage.findMany({
          where: { registrationId: linked.registrationId },
          include: {
            sponsorship: {
              select: {
                code: true,
                coversBasePrice: true,
                coveredAccessIds: true,
              },
            },
          },
        });

        // Detect coverage overlap (non-blocking, just warnings)
        const overlapWarnings = detectCoverageOverlap(
          existingUsages.map((u) => ({
            sponsorshipId: u.sponsorshipId,
            sponsorship: u.sponsorship,
          })),
          {
            coversBasePrice: linked.coversBasePrice,
            coveredAccessIds: linked.coveredAccessIds,
            totalAmount: 0, // Not needed for overlap detection
          },
        );

        if (overlapWarnings.length > 0) {
          logger.warn(
            {
              registrationId: linked.registrationId,
              beneficiaryName: linked.name,
              warnings: overlapWarnings,
            },
            "Coverage overlap detected in batch sponsorship linking",
          );
        }

        // Calculate total amount
        const totalAmount = await calculateSponsorshipTotal(
          tx,
          eventId,
          linked.coversBasePrice,
          linked.coveredAccessIds,
        );

        // Calculate applicable amount
        const priceBreakdown = parsePriceBreakdown(registration.priceBreakdown);
        const applicableAmount = calculateApplicableAmount(
          {
            coversBasePrice: linked.coversBasePrice,
            coveredAccessIds: linked.coveredAccessIds,
            totalAmount,
          },
          {
            totalAmount: registration.totalAmount,
            baseAmount: registration.baseAmount,
            accessTypeIds: registration.accessTypeIds,
            priceBreakdown,
          },
        );

        // Apply cap using cumulative amount
        const currentSponsorshipAmount = registrationSponsorshipAmounts.get(
          linked.registrationId,
        )!;
        const cappedAmount = capSponsorshipAmount(
          applicableAmount,
          currentSponsorshipAmount,
          registration.totalAmount,
        );

        // Skip if capped to zero (registration fully sponsored)
        if (cappedAmount === 0) {
          logger.warn(
            {
              registrationId: linked.registrationId,
              beneficiaryName: linked.name,
              applicableAmount,
              currentSponsorshipAmount,
            },
            "Skipping sponsorship link - registration is fully sponsored",
          );
          skippedCount++;
          continue;
        }

        // Generate unique code
        const code = await generateUniqueCode(tx);

        // Create sponsorship with USED status
        const sponsorship = await tx.sponsorship.create({
          data: {
            batchId: batch.id,
            eventId,
            code,
            status: "USED", // Auto-linked, so starts as USED
            beneficiaryName: linked.name,
            beneficiaryEmail: linked.email,
            beneficiaryPhone: null,
            beneficiaryAddress: null,
            coversBasePrice: linked.coversBasePrice,
            coveredAccessIds: linked.coveredAccessIds,
            totalAmount,
          },
        });

        // Create SponsorshipUsage (the link)
        await tx.sponsorshipUsage.create({
          data: {
            sponsorshipId: sponsorship.id,
            registrationId: linked.registrationId,
            amountApplied: cappedAmount,
            appliedBy: "SYSTEM", // System auto-linked
          },
        });

        // Update registration's sponsorshipAmount
        await tx.registration.update({
          where: { id: linked.registrationId },
          data: {
            sponsorshipAmount: { increment: cappedAmount },
          },
        });

        // Track cumulative amount for subsequent iterations
        registrationSponsorshipAmounts.set(
          linked.registrationId,
          currentSponsorshipAmount + cappedAmount,
        );

        createdSponsorships.push({
          ...sponsorship,
          linkedRegistrationId: linked.registrationId,
        });
      }
    } else {
      // CODE mode (existing behavior)
      for (const beneficiary of beneficiaries!) {
        // Generate unique code
        const code = await generateUniqueCode(tx);

        // Calculate total amount
        const totalAmount = await calculateSponsorshipTotal(
          tx,
          eventId,
          beneficiary.coversBasePrice,
          beneficiary.coveredAccessIds,
        );

        const sponsorship = await tx.sponsorship.create({
          data: {
            batchId: batch.id,
            eventId,
            code,
            status: "PENDING",
            beneficiaryName: beneficiary.name,
            beneficiaryEmail: beneficiary.email,
            beneficiaryPhone: beneficiary.phone ?? null,
            beneficiaryAddress: beneficiary.address ?? null,
            coversBasePrice: beneficiary.coversBasePrice,
            coveredAccessIds: beneficiary.coveredAccessIds,
            totalAmount,
          },
        });

        createdSponsorships.push(sponsorship);
      }
    }

    // Audit log for batch creation
    await tx.auditLog.create({
      data: {
        entityType: "Sponsorship",
        entityId: batch.id,
        action: "BATCH_CREATE",
        changes: {
          count: createdSponsorships.length,
          mode: isLinkedMode ? "LINKED_ACCOUNT" : "CODE",
        },
        performedBy: "PUBLIC",
      },
    });

    return {
      batchId: batch.id,
      count: createdSponsorships.length,
      skippedCount,
      batch: {
        labName: sponsor.labName,
        contactName: sponsor.contactName,
        email: sponsor.email,
        phone: sponsor.phone ?? null,
      },
      sponsorships: createdSponsorships,
      registrationSponsorshipAmounts,
    };
  });

  // Queue emails (outside transaction for reliability)
  try {
    // 1. Always send batch confirmation to lab
    const batchContext = buildBatchEmailContext({
      batch: result.batch,
      sponsorships: result.sponsorships.map((s) => ({
        beneficiaryName: s.beneficiaryName,
        beneficiaryEmail: s.beneficiaryEmail,
        totalAmount: s.totalAmount,
      })),
      event: {
        name: event.name,
        startDate: event.startDate,
        location: event.location,
        client: event.client,
      },
      currency,
    });

    const batchEmailQueued = await queueSponsorshipEmail(
      "SPONSORSHIP_BATCH_SUBMITTED",
      eventId,
      {
        recipientEmail: result.batch.email,
        recipientName: result.batch.contactName,
        context: batchContext,
      },
    );
    if (!batchEmailQueued) {
      logger.warn(
        { trigger: "SPONSORSHIP_BATCH_SUBMITTED", eventId },
        "No email template configured - lab will not receive confirmation email",
      );
    }

    // 2. For LINKED_ACCOUNT mode: Send notification to each doctor
    if (isLinkedMode) {
      for (const sponsorship of result.sponsorships) {
        const registration = registrations.get(
          sponsorship.linkedRegistrationId!,
        )!;

        // Get updated sponsorshipAmount from transaction result
        const updatedSponsorshipAmount =
          result.registrationSponsorshipAmounts.get(registration.id) ??
          registration.sponsorshipAmount;

        const context = buildLinkedSponsorshipContext({
          sponsorship: {
            code: sponsorship.code,
            beneficiaryName: sponsorship.beneficiaryName,
            coversBasePrice: sponsorship.coversBasePrice,
            coveredAccessIds: sponsorship.coveredAccessIds,
            totalAmount: sponsorship.totalAmount,
            batch: {
              labName: result.batch.labName,
              contactName: result.batch.contactName,
              email: result.batch.email,
            },
          },
          registration: {
            ...registration,
            phone: registration.phone ?? null,
            sponsorshipAmount: updatedSponsorshipAmount,
          },
          event: {
            name: event.name,
            slug: event.slug,
            startDate: event.startDate,
            location: event.location,
            client: event.client,
          },
          pricing: pricing ? { basePrice: pricing.basePrice } : null,
          accessItems,
          currency,
        });

        const linkedEmailQueued = await queueSponsorshipEmail(
          "SPONSORSHIP_LINKED",
          eventId,
          {
            recipientEmail: registration.email,
            recipientName:
              registration.firstName || sponsorship.beneficiaryName,
            context,
            registrationId: registration.id,
          },
        );
        if (!linkedEmailQueued) {
          logger.warn(
            {
              trigger: "SPONSORSHIP_LINKED",
              eventId,
              registrationId: registration.id,
            },
            "No email template configured - doctor will not receive sponsorship notification",
          );
        }
      }
    }
  } catch (emailError) {
    // Log error but don't fail the batch creation
    logger.error(
      { error: emailError, batchId: result.batchId },
      "Failed to queue sponsorship emails",
    );
  }

  return {
    batchId: result.batchId,
    count: result.count,
    skippedCount: result.skippedCount,
  };
}
