import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import {
  paginate,
  getSkip,
  type PaginatedResult,
} from "@shared/utils/pagination.js";
import { logger } from "@shared/utils/logger.js";
import {
  generateUniqueCode,
  calculateApplicableAmount,
  detectCoverageOverlap,
  validateCoveredAccessTimeOverlap,
  calculateTotalSponsorshipAmount,
  determineSponsorshipStatus,
  type RegistrationForCalculation,
  type ExistingUsage,
} from "./sponsorships.utils.js";
import type {
  CreateSponsorshipBatchInput,
  UpdateSponsorshipInput,
  ListSponsorshipsQuery,
} from "./sponsorships.schema.js";
import type {
  Prisma,
  Sponsorship,
  SponsorshipBatch,
  SponsorshipUsage,
} from "@/generated/prisma/client.js";
import {
  queueSponsorshipEmail,
  queueTriggeredEmail,
  buildBatchEmailContext,
  buildLinkedSponsorshipContext,
} from "@email";

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

type SponsorshipWithUsages = Sponsorship & {
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

export interface LinkSponsorshipResult {
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

export interface CreateBatchResult {
  batchId: string;
  count: number;
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

    // Read form settings for autoApproveSponsorship
    const formWithSettings = await tx.form.findUnique({
      where: { id: formId },
      select: { schema: true },
    });
    const sponsorshipSettings = (
      formWithSettings?.schema as Record<string, unknown> | null
    )?.sponsorshipSettings as Record<string, unknown> | undefined;
    const autoApprove =
      (sponsorshipSettings?.autoApproveSponsorship as boolean | undefined) ??
      true;

    // Create sponsorships
    const createdSponsorships: Array<
      Sponsorship & {
        linkedRegistrationId?: string;
        autoApproved?: boolean;
        applicableAmount?: number;
      }
    > = [];

    if (isLinkedMode) {
      // LINKED_ACCOUNT mode
      for (const linked of linkedBeneficiaries!) {
        const registration = registrations.get(linked.registrationId)!;

        // Generate unique code
        const code = await generateUniqueCode(tx);

        // Use registrant's actual base price (after conditional pricing rules)
        let totalAmount = 0;
        if (linked.coversBasePrice) {
          totalAmount += registration.baseAmount;
        }
        if (linked.coveredAccessIds.length > 0) {
          const coveredItems = await tx.eventAccess.findMany({
            where: {
              id: { in: linked.coveredAccessIds },
              eventId,
              active: true,
            },
            select: { price: true },
          });
          totalAmount += coveredItems.reduce(
            (sum: number, item: { price: number }) => sum + item.price,
            0,
          );
        }

        if (autoApprove) {
          // Auto-approve: create USED sponsorship and immediately link to registration
          const sponsorship = await tx.sponsorship.create({
            data: {
              batchId: batch.id,
              eventId,
              code,
              status: "USED",
              beneficiaryName: linked.name,
              beneficiaryEmail: linked.email,
              beneficiaryPhone: null,
              beneficiaryAddress: null,
              coversBasePrice: linked.coversBasePrice,
              coveredAccessIds: linked.coveredAccessIds,
              totalAmount,
            },
          });

          // Calculate applicable amount
          const priceBreakdown =
            registration.priceBreakdown as RegistrationForCalculation["priceBreakdown"];
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

          // Create SponsorshipUsage (the link)
          await tx.sponsorshipUsage.create({
            data: {
              sponsorshipId: sponsorship.id,
              registrationId: linked.registrationId,
              amountApplied: applicableAmount,
              appliedBy: "SYSTEM",
            },
          });

          // Update registration's sponsorshipAmount and paymentMethod
          await tx.registration.update({
            where: { id: linked.registrationId },
            data: {
              sponsorshipAmount: { increment: applicableAmount },
              paymentMethod: "LAB_SPONSORSHIP",
            },
          });

          createdSponsorships.push({
            ...sponsorship,
            linkedRegistrationId: linked.registrationId,
            autoApproved: true,
            applicableAmount,
          });
        } else {
          // Pending approval: create PENDING sponsorship with targetRegistrationId
          const sponsorship = await tx.sponsorship.create({
            data: {
              batchId: batch.id,
              eventId,
              code,
              status: "PENDING",
              beneficiaryName: linked.name,
              beneficiaryEmail: linked.email,
              beneficiaryPhone: null,
              beneficiaryAddress: null,
              coversBasePrice: linked.coversBasePrice,
              coveredAccessIds: linked.coveredAccessIds,
              totalAmount,
              targetRegistrationId: linked.registrationId,
            },
          });

          createdSponsorships.push({
            ...sponsorship,
            linkedRegistrationId: linked.registrationId,
            autoApproved: false,
          });
        }
      }
    } else {
      // CODE mode (existing behavior)
      for (const beneficiary of beneficiaries!) {
        // Generate unique code
        const code = await generateUniqueCode(tx);

        // Calculate total amount
        let totalAmount = 0;
        if (beneficiary.coversBasePrice) {
          const pricing = await tx.eventPricing.findUnique({
            where: { eventId },
            select: { basePrice: true },
          });
          totalAmount += pricing?.basePrice ?? 0;
        }
        if (beneficiary.coveredAccessIds.length > 0) {
          const accessItems = await tx.eventAccess.findMany({
            where: {
              id: { in: beneficiary.coveredAccessIds },
              eventId,
              active: true,
            },
            select: { price: true },
          });
          totalAmount += accessItems.reduce(
            (sum: number, item: { price: number }) => sum + item.price,
            0,
          );
        }

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

    return {
      batchId: batch.id,
      count: createdSponsorships.length,
      autoApprove,
      batch: {
        labName: sponsor.labName,
        contactName: sponsor.contactName,
        email: sponsor.email,
        phone: sponsor.phone ?? null,
      },
      sponsorships: createdSponsorships,
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

    // 2. For LINKED_ACCOUNT mode with auto-approve: Send notification to each doctor
    if (isLinkedMode && result.autoApprove) {
      for (const sponsorship of result.sponsorships) {
        const registration = registrations.get(
          sponsorship.linkedRegistrationId!,
        )!;

        // Update sponsorshipAmount with the new total (after increment)
        const updatedReg = await prisma.registration.findUnique({
          where: { id: registration.id },
          select: {
            sponsorshipAmount: true,
            totalAmount: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        });

        const context = buildLinkedSponsorshipContext({
          amountApplied: sponsorship.applicableAmount!,
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
            sponsorshipAmount:
              updatedReg?.sponsorshipAmount ?? registration.sponsorshipAmount,
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

        // Check sponsorship coverage and queue PAYMENT_CONFIRMED or SPONSORSHIP_PARTIAL
        const currentSponsorshipAmount =
          updatedReg?.sponsorshipAmount ?? registration.sponsorshipAmount;
        const currentTotalAmount =
          updatedReg?.totalAmount ?? registration.totalAmount;

        if (currentSponsorshipAmount >= currentTotalAmount) {
          // Fully sponsored: mark as PAID and queue PAYMENT_CONFIRMED
          await prisma.registration.update({
            where: { id: registration.id },
            data: {
              paymentStatus: "PAID",
              paidAt: new Date(),
              paymentMethod: "LAB_SPONSORSHIP",
            },
          });

          await queueTriggeredEmail("PAYMENT_CONFIRMED", eventId, {
            id: registration.id,
            email: updatedReg?.email ?? registration.email,
            firstName: updatedReg?.firstName ?? registration.firstName,
            lastName: updatedReg?.lastName ?? registration.lastName,
          });
        } else if (currentSponsorshipAmount > 0) {
          // Partially sponsored: queue SPONSORSHIP_PARTIAL
          const partialQueued = await queueSponsorshipEmail(
            "SPONSORSHIP_PARTIAL",
            eventId,
            {
              recipientEmail: registration.email,
              recipientName:
                registration.firstName || sponsorship.beneficiaryName,
              context,
              registrationId: registration.id,
            },
          );
          if (!partialQueued) {
            logger.warn(
              {
                trigger: "SPONSORSHIP_PARTIAL",
                eventId,
                registrationId: registration.id,
              },
              "No email template configured - doctor will not receive partial sponsorship notification",
            );
          }
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
  };
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
): Promise<SponsorshipWithUsages> {
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
    return cancelSponsorship(id);
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
      // Fetch access items with time data
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
    let totalAmount = 0;
    if (coversBasePrice) {
      const pricing = await prisma.eventPricing.findUnique({
        where: { eventId: sponsorship.eventId },
        select: { basePrice: true },
      });
      totalAmount += pricing?.basePrice ?? 0;
    }
    if (coveredAccessIds.length > 0) {
      const accessItems = await prisma.eventAccess.findMany({
        where: {
          id: { in: coveredAccessIds },
          eventId: sponsorship.eventId,
          active: true,
        },
        select: { price: true },
      });
      totalAmount += accessItems.reduce(
        (sum: number, item: { price: number }) => sum + item.price,
        0,
      );
    }
    updateData.totalAmount = totalAmount;
  }

  // Update sponsorship and recalculate usage amounts atomically.
  // Wrapping both in a transaction prevents partial state where the sponsorship
  // is updated but linked registration amounts reflect old coverage values.
  await prisma.$transaction(async (tx) => {
    await tx.sponsorship.update({
      where: { id },
      data: updateData,
    });

    if (sponsorship.usages.length > 0) {
      await recalculateUsageAmounts(id, tx);
    }
  });

  return getSponsorshipById(id) as Promise<SponsorshipWithUsages>;
}

// ============================================================================
// Cancel Sponsorship (Admin)
// ============================================================================

/**
 * Cancel a sponsorship and unlink from all registrations.
 */
export async function cancelSponsorship(
  id: string,
): Promise<SponsorshipWithUsages> {
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
  });

  return getSponsorshipById(id) as Promise<SponsorshipWithUsages>;
}

// ============================================================================
// Delete Sponsorship (Admin)
// ============================================================================

/**
 * Delete a sponsorship permanently.
 * Unlinks from registrations first if needed.
 */
export async function deleteSponsorship(id: string): Promise<void> {
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

    // Delete sponsorship (cascade will delete usages)
    await tx.sponsorship.delete({ where: { id } });
  });
}

// ============================================================================
// Link Sponsorship to Registration (Admin)
// ============================================================================

/**
 * Link a sponsorship to a registration by sponsorship ID.
 */
export async function linkSponsorshipToRegistration(
  sponsorshipId: string,
  registrationId: string,
  adminUserId: string,
): Promise<LinkSponsorshipResult> {
  const sponsorship = await prisma.sponsorship.findUnique({
    where: { id: sponsorshipId },
    include: {
      usages: {
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

  if (!sponsorship) {
    throw new AppError(
      "Sponsorship not found",
      404,
      true,
      ErrorCodes.NOT_FOUND,
    );
  }

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
      true,
      ErrorCodes.REGISTRATION_NOT_FOUND,
    );
  }

  // Verify same event
  if (sponsorship.eventId !== registration.eventId) {
    throw new AppError(
      "Sponsorship and registration must be for the same event",
      400,
      true,
      ErrorCodes.BAD_REQUEST,
    );
  }

  // Check if already linked
  const existingLink = await prisma.sponsorshipUsage.findUnique({
    where: {
      sponsorshipId_registrationId: { sponsorshipId, registrationId },
    },
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

  // Detect coverage overlap with existing sponsorships
  const existingUsages: ExistingUsage[] = registration.sponsorshipUsages.map(
    (u) => ({
      sponsorshipId: u.sponsorshipId,
      sponsorship: u.sponsorship,
    }),
  );

  const warnings = detectCoverageOverlap(existingUsages, {
    coversBasePrice: sponsorship.coversBasePrice,
    coveredAccessIds: sponsorship.coveredAccessIds,
    totalAmount: sponsorship.totalAmount,
  });

  // Calculate applicable amount
  const priceBreakdown =
    registration.priceBreakdown as RegistrationForCalculation["priceBreakdown"];
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

  // Validate coverage applies - reject if $0 would be applied but sponsorship has value
  if (applicableAmount === 0 && sponsorship.totalAmount > 0) {
    throw new AppError(
      "Sponsorship coverage does not apply to this registration (no overlap between sponsored items and registration selections)",
      400,
      true,
      ErrorCodes.SPONSORSHIP_NOT_APPLICABLE,
    );
  }

  // Create usage and update records in transaction
  const result = await prisma.$transaction(async (tx) => {
    // Create sponsorship usage
    const usage = await tx.sponsorshipUsage.create({
      data: {
        sponsorshipId,
        registrationId,
        amountApplied: applicableAmount,
        appliedBy: adminUserId,
      },
    });

    // Update sponsorship status to USED (atomic with status check to prevent race)
    const statusUpdate = await tx.sponsorship.updateMany({
      where: {
        id: sponsorshipId,
        status: { not: "CANCELLED" }, // Only update if not cancelled
      },
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

    // Calculate new total sponsorship amount for registration
    const allUsages = await tx.sponsorshipUsage.findMany({
      where: { registrationId },
      select: { amountApplied: true },
    });

    const newSponsorshipAmount = calculateTotalSponsorshipAmount(allUsages);

    // Update registration sponsorship amount and paymentMethod
    const isFullySponsored = newSponsorshipAmount >= registration.totalAmount;
    await tx.registration.update({
      where: { id: registrationId },
      data: {
        sponsorshipAmount: newSponsorshipAmount,
        paymentMethod: "LAB_SPONSORSHIP",
        // Auto-mark as PAID inside the transaction to prevent race conditions
        // where concurrent links could both read "not yet paid" and double-process
        ...(isFullySponsored
          ? { paymentStatus: "PAID", paidAt: new Date() }
          : {}),
      },
    });

    return {
      usage: {
        id: usage.id,
        sponsorshipId: usage.sponsorshipId,
        amountApplied: usage.amountApplied,
      },
      registration: {
        totalAmount: registration.totalAmount,
        sponsorshipAmount: newSponsorshipAmount,
        amountDue: Math.max(0, registration.totalAmount - newSponsorshipAmount),
      },
      warnings,
    };
  });

  // Queue SPONSORSHIP_APPLIED email to the doctor
  try {
    // Fetch data needed for email context
    const [
      sponsorshipWithBatch,
      registrationDetails,
      event,
      pricing,
      accessItems,
    ] = await Promise.all([
      prisma.sponsorship.findUnique({
        where: { id: sponsorshipId },
        include: {
          batch: { select: { labName: true, contactName: true, email: true } },
        },
      }),
      prisma.registration.findUnique({
        where: { id: registrationId },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          totalAmount: true,
          baseAmount: true,
          sponsorshipAmount: true,
          linkBaseUrl: true,
          editToken: true,
        },
      }),
      prisma.event.findUnique({
        where: { id: sponsorship.eventId },
        select: {
          name: true,
          slug: true,
          startDate: true,
          location: true,
          client: { select: { name: true } },
        },
      }),
      prisma.eventPricing.findUnique({
        where: { eventId: sponsorship.eventId },
        select: { basePrice: true, currency: true },
      }),
      sponsorship.coveredAccessIds.length > 0
        ? prisma.eventAccess.findMany({
            where: { id: { in: sponsorship.coveredAccessIds } },
            select: { id: true, name: true, price: true },
          })
        : Promise.resolve([]),
    ]);

    if (sponsorshipWithBatch && registrationDetails && event) {
      const currency = pricing?.currency ?? "TND";
      const context = buildLinkedSponsorshipContext({
        amountApplied: result.usage.amountApplied,
        sponsorship: {
          code: sponsorshipWithBatch.code,
          beneficiaryName: sponsorshipWithBatch.beneficiaryName,
          coversBasePrice: sponsorshipWithBatch.coversBasePrice,
          coveredAccessIds: sponsorshipWithBatch.coveredAccessIds,
          totalAmount: sponsorshipWithBatch.totalAmount,
          batch: {
            labName: sponsorshipWithBatch.batch.labName,
            contactName: sponsorshipWithBatch.batch.contactName,
            email: sponsorshipWithBatch.batch.email,
          },
        },
        registration: registrationDetails,
        event,
        pricing: pricing ? { basePrice: pricing.basePrice } : null,
        accessItems,
        currency,
      });

      const appliedEmailQueued = await queueSponsorshipEmail(
        "SPONSORSHIP_APPLIED",
        sponsorship.eventId,
        {
          recipientEmail: registrationDetails.email,
          recipientName:
            registrationDetails.firstName ||
            sponsorshipWithBatch.beneficiaryName,
          context,
          registrationId: registrationDetails.id,
        },
      );
      if (!appliedEmailQueued) {
        logger.warn(
          {
            trigger: "SPONSORSHIP_APPLIED",
            eventId: sponsorship.eventId,
            registrationId,
          },
          "No email template configured - doctor will not receive sponsorship notification",
        );
      }
    }
  } catch (emailError) {
    // Log error but don't fail the link operation
    logger.error(
      { error: emailError, sponsorshipId, registrationId },
      "Failed to queue SPONSORSHIP_APPLIED email",
    );
  }

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
): Promise<LinkSponsorshipResult> {
  const registration = await prisma.registration.findUnique({
    where: { id: registrationId },
    select: { eventId: true },
  });

  if (!registration) {
    throw new AppError(
      "Registration not found",
      404,
      true,
      ErrorCodes.REGISTRATION_NOT_FOUND,
    );
  }

  const sponsorship = await getSponsorshipByCode(registration.eventId, code);

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
async function unlinkSponsorshipFromRegistrationInternal(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  sponsorshipId: string,
  registrationId: string,
): Promise<void> {
  const usage = await tx.sponsorshipUsage.findUnique({
    where: {
      sponsorshipId_registrationId: { sponsorshipId, registrationId },
    },
  });

  if (!usage) {
    throw new AppError(
      "Sponsorship is not linked to this registration",
      404,
      true,
      ErrorCodes.NOT_FOUND,
    );
  }

  // Delete the usage
  await tx.sponsorshipUsage.delete({
    where: { id: usage.id },
  });

  // Recalculate registration's sponsorship amount
  const remainingUsages = await tx.sponsorshipUsage.findMany({
    where: { registrationId },
    select: { amountApplied: true },
  });

  const newSponsorshipAmount = calculateTotalSponsorshipAmount(remainingUsages);

  await tx.registration.update({
    where: { id: registrationId },
    data: {
      sponsorshipAmount: newSponsorshipAmount,
      ...(newSponsorshipAmount === 0 && { paymentMethod: null }),
    },
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
      true,
      ErrorCodes.REGISTRATION_NOT_FOUND,
    );
  }

  if (registration.eventId !== eventId) {
    throw new AppError(
      "Registration does not belong to this event",
      400,
      true,
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

// Structural type for the db client used in recalculateUsageAmounts.
// Accepts either the global prisma instance or a transaction client (tx).
type RecalcDbClient = {
  sponsorship: Pick<typeof prisma.sponsorship, "findUnique">;
  sponsorshipUsage: Pick<typeof prisma.sponsorshipUsage, "update" | "findMany">;
  registration: Pick<typeof prisma.registration, "update">;
};

/**
 * Recalculate usage amounts for all usages of a sponsorship.
 * Called after sponsorship coverage is updated.
 *
 * Pass `db` (a transaction client `tx`) to run all updates atomically.
 * A failure mid-loop will roll back all partial changes.
 */
async function recalculateUsageAmounts(
  sponsorshipId: string,
  db: RecalcDbClient = prisma,
): Promise<void> {
  const sponsorship = await db.sponsorship.findUnique({
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
    // Skip if registration was deleted
    if (!usage.registration) continue;

    const priceBreakdown = usage.registration
      .priceBreakdown as RegistrationForCalculation["priceBreakdown"];

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

    await db.sponsorshipUsage.update({
      where: { id: usage.id },
      data: { amountApplied: newAmount },
    });

    // Recalculate registration total sponsorship
    const allUsages = await db.sponsorshipUsage.findMany({
      where: { registrationId: usage.registration.id },
      select: { amountApplied: true },
    });

    const totalSponsorshipAmount = calculateTotalSponsorshipAmount(allUsages);

    await db.registration.update({
      where: { id: usage.registration.id },
      data: { sponsorshipAmount: totalSponsorshipAmount },
    });
  }
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
