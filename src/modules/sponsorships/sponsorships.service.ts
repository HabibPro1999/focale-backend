import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import {
  paginate,
  getSkip,
  type PaginatedResult,
} from "@shared/utils/pagination.js";
import { logger } from "@shared/utils/logger.js";
import { auditLog } from "@shared/utils/audit.js";
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
  BeneficiaryInput,
  LinkedBeneficiaryInput,
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

type EventForBatch = {
  id: string;
  name: string;
  slug: string;
  status: string;
  startDate: Date;
  location: string | null;
  client: { name: string };
};

type PricingForBatch = {
  basePrice: number;
  currency: string;
};

type AccessItemForBatch = {
  id: string;
  name: string;
  price: number;
  type: string;
  groupLabel: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
};

type LinkedRegistrationForBatch = {
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
};

type BatchValidationContext = {
  event: EventForBatch;
  formId: string;
  pricing: PricingForBatch | null;
  currency: string;
  accessItems: AccessItemForBatch[];
  accessPriceMap: Map<string, number>;
  isLinkedMode: boolean;
  beneficiaries: BeneficiaryInput[];
  linkedBeneficiaries: LinkedBeneficiaryInput[];
  registrations: Map<string, LinkedRegistrationForBatch>;
};

type CreatedBatchSponsorship = Sponsorship & {
  linkedRegistrationId?: string;
  autoApproved?: boolean;
  applicableAmount?: number;
};

type LinkedEmailEntry = {
  amountApplied: number;
  isFullySponsored: boolean;
  sponsorship: {
    code: string;
    beneficiaryName: string;
    coversBasePrice: boolean;
    coveredAccessIds: string[];
    totalAmount: number;
  };
  registration: LinkedRegistrationForBatch;
};

type BatchTransactionResult = {
  batchId: string;
  count: number;
  autoApprove: boolean;
  batch: {
    labName: string;
    contactName: string;
    email: string;
    phone: string | null;
  };
  sponsorships: CreatedBatchSponsorship[];
  linkedEmailEntries: LinkedEmailEntry[];
};

type TxClient = Omit<
  typeof prisma,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

type UnlinkUsageRef = {
  registrationId: string | null;
};

function calculateCoveredAccessTotal(
  coveredAccessIds: string[],
  accessPriceMap: Map<string, number>,
): number {
  return coveredAccessIds.reduce(
    (sum, accessId) => sum + (accessPriceMap.get(accessId) ?? 0),
    0,
  );
}

async function unlinkSponsorshipFromAllRegistrations(
  tx: TxClient,
  sponsorshipId: string,
  usages: UnlinkUsageRef[],
  performedBy?: string,
): Promise<void> {
  for (const usage of usages) {
    if (!usage.registrationId) {
      continue;
    }

    await unlinkSponsorshipFromRegistrationInternal(
      tx,
      sponsorshipId,
      usage.registrationId,
      performedBy,
    );
  }
}

async function validateBatchInput(
  eventId: string,
  formId: string,
  input: CreateSponsorshipBatchInput,
): Promise<BatchValidationContext> {
  const { beneficiaries = [], linkedBeneficiaries = [] } = input;
  const isLinkedMode = linkedBeneficiaries.length > 0;

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
    throw new AppError("Event not found", 404, ErrorCodes.NOT_FOUND);
  }

  const form = await prisma.form.findFirst({
    where: { id: formId, eventId, type: "SPONSOR" },
    select: { id: true },
  });

  if (!form) {
    throw new AppError(
      "Sponsor form not found for this event",
      404,
      ErrorCodes.NOT_FOUND,
    );
  }

  const pricing = await prisma.eventPricing.findUnique({
    where: { eventId },
    select: { basePrice: true, currency: true },
  });

  const beneficiaryList = isLinkedMode ? linkedBeneficiaries : beneficiaries;
  const allAccessIds = new Set<string>();
  for (const beneficiary of beneficiaryList) {
    for (const accessId of beneficiary.coveredAccessIds) {
      allAccessIds.add(accessId);
    }
  }

  let accessItems: AccessItemForBatch[] = [];
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
        ErrorCodes.BAD_REQUEST,
        { invalidAccessIds: invalidIds },
      );
    }

    const overlapErrors: string[] = [];
    beneficiaryList.forEach((beneficiary, index) => {
      if (beneficiary.coveredAccessIds.length < 2) {
        return;
      }

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
    });

    if (overlapErrors.length > 0) {
      throw new AppError(
        `Time conflicts in covered access items: ${overlapErrors.join("; ")}`,
        400,
        ErrorCodes.BAD_REQUEST,
        { timeConflicts: overlapErrors },
      );
    }
  }

  const registrations = new Map<string, LinkedRegistrationForBatch>();
  if (isLinkedMode) {
    const registrationIds = linkedBeneficiaries.map((b) => b.registrationId);
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

    const foundIds = new Set(foundRegistrations.map((r) => r.id));
    const missingIds = registrationIds.filter((id) => !foundIds.has(id));
    if (missingIds.length > 0) {
      throw new AppError(
        `Registrations not found: ${missingIds.join(", ")}`,
        404,
        ErrorCodes.NOT_FOUND,
        { missingRegistrationIds: missingIds },
      );
    }

    for (const registration of foundRegistrations) {
      registrations.set(registration.id, registration);
    }
  }

  return {
    event,
    formId: form.id,
    pricing,
    currency: pricing?.currency ?? "TND",
    accessItems,
    accessPriceMap: new Map(accessItems.map((item) => [item.id, item.price])),
    isLinkedMode,
    beneficiaries,
    linkedBeneficiaries,
    registrations,
  };
}

async function createCodeModeSponsorships(
  tx: TxClient,
  eventId: string,
  batchId: string,
  beneficiaries: BeneficiaryInput[],
  basePrice: number,
  accessPriceMap: Map<string, number>,
): Promise<CreatedBatchSponsorship[]> {
  const created: CreatedBatchSponsorship[] = [];

  for (const beneficiary of beneficiaries) {
    const code = await generateUniqueCode(tx);
    const totalAmount =
      (beneficiary.coversBasePrice ? basePrice : 0) +
      calculateCoveredAccessTotal(beneficiary.coveredAccessIds, accessPriceMap);

    const sponsorship = await tx.sponsorship.create({
      data: {
        batchId,
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

    created.push(sponsorship);
  }

  return created;
}

async function createLinkedModeSponsorships(
  tx: TxClient,
  eventId: string,
  batchId: string,
  linkedBeneficiaries: LinkedBeneficiaryInput[],
  registrations: Map<string, LinkedRegistrationForBatch>,
  autoApprove: boolean,
  accessPriceMap: Map<string, number>,
): Promise<{
  created: CreatedBatchSponsorship[];
  linkedEmailEntries: LinkedEmailEntry[];
}> {
  const created: CreatedBatchSponsorship[] = [];
  const linkedEmailEntries: LinkedEmailEntry[] = [];

  for (const linked of linkedBeneficiaries) {
    const registration = registrations.get(linked.registrationId);
    if (!registration) {
      throw new AppError(
        "Registration not found",
        404,
        ErrorCodes.REGISTRATION_NOT_FOUND,
      );
    }

    const code = await generateUniqueCode(tx);
    const totalAmount =
      (linked.coversBasePrice ? registration.baseAmount : 0) +
      calculateCoveredAccessTotal(linked.coveredAccessIds, accessPriceMap);

    if (!autoApprove) {
      const sponsorship = await tx.sponsorship.create({
        data: {
          batchId,
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

      created.push({
        ...sponsorship,
        linkedRegistrationId: linked.registrationId,
        autoApproved: false,
      });
      continue;
    }

    const sponsorship = await tx.sponsorship.create({
      data: {
        batchId,
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

    await tx.sponsorshipUsage.create({
      data: {
        sponsorshipId: sponsorship.id,
        registrationId: linked.registrationId,
        amountApplied: applicableAmount,
        appliedBy: "SYSTEM",
      },
    });

    const updatedSponsorshipAmount =
      registration.sponsorshipAmount + applicableAmount;
    const isFullySponsored =
      updatedSponsorshipAmount >= registration.totalAmount;

    await tx.registration.update({
      where: { id: linked.registrationId },
      data: {
        sponsorshipAmount: updatedSponsorshipAmount,
        paymentMethod: "LAB_SPONSORSHIP",
        ...(isFullySponsored
          ? { paymentStatus: "PAID", paidAt: new Date() }
          : {}),
      },
    });

    registration.sponsorshipAmount = updatedSponsorshipAmount;

    created.push({
      ...sponsorship,
      linkedRegistrationId: linked.registrationId,
      autoApproved: true,
      applicableAmount,
    });

    linkedEmailEntries.push({
      amountApplied: applicableAmount,
      isFullySponsored,
      sponsorship: {
        code: sponsorship.code,
        beneficiaryName: sponsorship.beneficiaryName,
        coversBasePrice: sponsorship.coversBasePrice,
        coveredAccessIds: sponsorship.coveredAccessIds,
        totalAmount: sponsorship.totalAmount,
      },
      registration: {
        ...registration,
      },
    });
  }

  return { created, linkedEmailEntries };
}

async function queueBatchEmails(input: {
  eventId: string;
  event: EventForBatch;
  pricing: PricingForBatch | null;
  currency: string;
  accessItems: AccessItemForBatch[];
  isLinkedMode: boolean;
  result: BatchTransactionResult;
}): Promise<void> {
  const {
    eventId,
    event,
    pricing,
    currency,
    accessItems,
    isLinkedMode,
    result,
  } = input;

  try {
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

    if (!isLinkedMode || !result.autoApprove) {
      return;
    }

    for (const entry of result.linkedEmailEntries) {
      const context = buildLinkedSponsorshipContext({
        amountApplied: entry.amountApplied,
        sponsorship: {
          code: entry.sponsorship.code,
          beneficiaryName: entry.sponsorship.beneficiaryName,
          coversBasePrice: entry.sponsorship.coversBasePrice,
          coveredAccessIds: entry.sponsorship.coveredAccessIds,
          totalAmount: entry.sponsorship.totalAmount,
          batch: {
            labName: result.batch.labName,
            contactName: result.batch.contactName,
            email: result.batch.email,
          },
        },
        registration: {
          ...entry.registration,
          phone: entry.registration.phone ?? null,
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
          recipientEmail: entry.registration.email,
          recipientName:
            entry.registration.firstName || entry.sponsorship.beneficiaryName,
          context,
          registrationId: entry.registration.id,
        },
      );
      if (!linkedEmailQueued) {
        logger.warn(
          {
            trigger: "SPONSORSHIP_LINKED",
            eventId,
            registrationId: entry.registration.id,
          },
          "No email template configured - doctor will not receive sponsorship notification",
        );
      }

      if (entry.isFullySponsored) {
        await queueTriggeredEmail("PAYMENT_CONFIRMED", eventId, {
          id: entry.registration.id,
          email: entry.registration.email,
          firstName: entry.registration.firstName,
          lastName: entry.registration.lastName,
        });
      } else if (entry.registration.sponsorshipAmount > 0) {
        const partialQueued = await queueSponsorshipEmail(
          "SPONSORSHIP_PARTIAL",
          eventId,
          {
            recipientEmail: entry.registration.email,
            recipientName:
              entry.registration.firstName || entry.sponsorship.beneficiaryName,
            context,
            registrationId: entry.registration.id,
          },
        );
        if (!partialQueued) {
          logger.warn(
            {
              trigger: "SPONSORSHIP_PARTIAL",
              eventId,
              registrationId: entry.registration.id,
            },
            "No email template configured - doctor will not receive partial sponsorship notification",
          );
        }
      }
    }
  } catch (emailError) {
    logger.error(
      { error: emailError, batchId: result.batchId },
      "Failed to queue sponsorship emails",
    );
  }
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
  const { sponsor, customFields } = input;

  const context = await validateBatchInput(eventId, formId, input);

  const result = await prisma.$transaction(async (tx) => {
    const batch = await tx.sponsorshipBatch.create({
      data: {
        eventId,
        formId: context.formId,
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

    const formWithSettings = await tx.form.findUnique({
      where: { id: context.formId },
      select: { schema: true },
    });
    const sponsorshipSettings = (
      formWithSettings?.schema as Record<string, unknown> | null
    )?.sponsorshipSettings as Record<string, unknown> | undefined;
    const autoApprove =
      (sponsorshipSettings?.autoApproveSponsorship as boolean | undefined) ??
      true;

    let createdSponsorships: CreatedBatchSponsorship[] = [];
    let linkedEmailEntries: LinkedEmailEntry[] = [];

    if (context.isLinkedMode) {
      const linkedResult = await createLinkedModeSponsorships(
        tx,
        eventId,
        batch.id,
        context.linkedBeneficiaries,
        context.registrations,
        autoApprove,
        context.accessPriceMap,
      );
      createdSponsorships = linkedResult.created;
      linkedEmailEntries = linkedResult.linkedEmailEntries;
    } else {
      createdSponsorships = await createCodeModeSponsorships(
        tx,
        eventId,
        batch.id,
        context.beneficiaries,
        context.pricing?.basePrice ?? 0,
        context.accessPriceMap,
      );
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
      linkedEmailEntries,
    } satisfies BatchTransactionResult;
  });

  await queueBatchEmails({
    eventId,
    event: context.event,
    pricing: context.pricing,
    currency: context.currency,
    accessItems: context.accessItems,
    isLinkedMode: context.isLinkedMode,
    result,
  });

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
// Update Sponsorship (Admin)
// ============================================================================

/**
 * Update sponsorship coverage, beneficiary info, or cancel it.
 */
export async function updateSponsorship(
  id: string,
  input: UpdateSponsorshipInput,
  performedBy?: string,
): Promise<SponsorshipWithUsages> {
  if (input.status === "CANCELLED") {
    return cancelSponsorship(id, performedBy);
  }

  await prisma.$transaction(async (tx) => {
    const sponsorship = await tx.sponsorship.findUnique({
      where: { id },
      include: { usages: true },
    });

    if (!sponsorship) {
      throw new AppError("Sponsorship not found", 404, ErrorCodes.NOT_FOUND);
    }

    const coverageChanged =
      input.coversBasePrice !== undefined ||
      input.coveredAccessIds !== undefined;

    const nextCoversBasePrice =
      input.coversBasePrice ?? sponsorship.coversBasePrice;
    const nextCoveredAccessIds =
      input.coveredAccessIds ?? sponsorship.coveredAccessIds;

    if (
      input.coveredAccessIds !== undefined &&
      nextCoveredAccessIds.length >= 2
    ) {
      const accessItems = await tx.eventAccess.findMany({
        where: {
          id: { in: nextCoveredAccessIds },
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
        nextCoveredAccessIds,
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
          ErrorCodes.BAD_REQUEST,
          { timeConflicts: timeErrors },
        );
      }
    }

    let nextTotalAmount = sponsorship.totalAmount;
    if (coverageChanged) {
      nextTotalAmount = 0;
      if (nextCoversBasePrice) {
        const pricing = await tx.eventPricing.findUnique({
          where: { eventId: sponsorship.eventId },
          select: { basePrice: true },
        });
        nextTotalAmount += pricing?.basePrice ?? 0;
      }

      if (nextCoveredAccessIds.length > 0) {
        const accessItems = await tx.eventAccess.findMany({
          where: {
            id: { in: nextCoveredAccessIds },
            eventId: sponsorship.eventId,
            active: true,
          },
          select: { price: true },
        });
        nextTotalAmount += accessItems.reduce(
          (sum, item) => sum + item.price,
          0,
        );
      }
    }

    const updateData: Prisma.SponsorshipUpdateInput = {};
    if (input.beneficiaryName !== undefined) {
      updateData.beneficiaryName = input.beneficiaryName;
    }
    if (input.beneficiaryEmail !== undefined) {
      updateData.beneficiaryEmail = input.beneficiaryEmail;
    }
    if (input.beneficiaryPhone !== undefined) {
      updateData.beneficiaryPhone = input.beneficiaryPhone;
    }
    if (input.beneficiaryAddress !== undefined) {
      updateData.beneficiaryAddress = input.beneficiaryAddress;
    }
    if (coverageChanged) {
      updateData.coversBasePrice = nextCoversBasePrice;
      updateData.coveredAccessIds = nextCoveredAccessIds;
      updateData.totalAmount = nextTotalAmount;
    }

    const changes: Record<string, { old: unknown; new: unknown }> = {};
    if (
      input.beneficiaryName !== undefined &&
      input.beneficiaryName !== sponsorship.beneficiaryName
    ) {
      changes.beneficiaryName = {
        old: sponsorship.beneficiaryName,
        new: input.beneficiaryName,
      };
    }
    if (
      input.beneficiaryEmail !== undefined &&
      input.beneficiaryEmail !== sponsorship.beneficiaryEmail
    ) {
      changes.beneficiaryEmail = {
        old: sponsorship.beneficiaryEmail,
        new: input.beneficiaryEmail,
      };
    }
    if (
      input.beneficiaryPhone !== undefined &&
      input.beneficiaryPhone !== sponsorship.beneficiaryPhone
    ) {
      changes.beneficiaryPhone = {
        old: sponsorship.beneficiaryPhone,
        new: input.beneficiaryPhone,
      };
    }
    if (
      input.beneficiaryAddress !== undefined &&
      input.beneficiaryAddress !== sponsorship.beneficiaryAddress
    ) {
      changes.beneficiaryAddress = {
        old: sponsorship.beneficiaryAddress,
        new: input.beneficiaryAddress,
      };
    }
    if (coverageChanged) {
      if (nextCoversBasePrice !== sponsorship.coversBasePrice) {
        changes.coversBasePrice = {
          old: sponsorship.coversBasePrice,
          new: nextCoversBasePrice,
        };
      }
      if (
        JSON.stringify(nextCoveredAccessIds) !==
        JSON.stringify(sponsorship.coveredAccessIds)
      ) {
        changes.coveredAccessIds = {
          old: sponsorship.coveredAccessIds,
          new: nextCoveredAccessIds,
        };
      }
      if (nextTotalAmount !== sponsorship.totalAmount) {
        changes.totalAmount = {
          old: sponsorship.totalAmount,
          new: nextTotalAmount,
        };
      }
    }

    if (Object.keys(updateData).length > 0) {
      await tx.sponsorship.update({
        where: { id },
        data: updateData,
      });
    }

    if (coverageChanged && sponsorship.usages.length > 0) {
      await recalculateUsageAmounts(id, tx);
    }

    if (Object.keys(changes).length > 0) {
      await auditLog(tx, {
        entityType: "Sponsorship",
        entityId: id,
        action: "UPDATE",
        changes,
        performedBy,
      });
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
  performedBy?: string,
): Promise<SponsorshipWithUsages> {
  await prisma.$transaction(async (tx) => {
    const sponsorship = await tx.sponsorship.findUnique({
      where: { id },
      include: { usages: { select: { registrationId: true } } },
    });

    if (!sponsorship) {
      throw new AppError("Sponsorship not found", 404, ErrorCodes.NOT_FOUND);
    }

    await unlinkSponsorshipFromAllRegistrations(
      tx,
      id,
      sponsorship.usages,
      performedBy,
    );

    if (sponsorship.status !== "CANCELLED") {
      await tx.sponsorship.update({
        where: { id },
        data: { status: "CANCELLED" },
      });

      await auditLog(tx, {
        entityType: "Sponsorship",
        entityId: id,
        action: "CANCEL",
        changes: {
          status: { old: sponsorship.status, new: "CANCELLED" },
        },
        performedBy,
      });
    }
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
export async function deleteSponsorship(
  id: string,
  performedBy?: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const sponsorship = await tx.sponsorship.findUnique({
      where: { id },
      include: { usages: { select: { registrationId: true } } },
    });

    if (!sponsorship) {
      throw new AppError("Sponsorship not found", 404, ErrorCodes.NOT_FOUND);
    }

    await unlinkSponsorshipFromAllRegistrations(
      tx,
      id,
      sponsorship.usages,
      performedBy,
    );

    await auditLog(tx, {
      entityType: "Sponsorship",
      entityId: id,
      action: "DELETE",
      changes: {
        code: { old: sponsorship.code, new: null },
        status: { old: sponsorship.status, new: null },
        beneficiaryName: { old: sponsorship.beneficiaryName, new: null },
        beneficiaryEmail: { old: sponsorship.beneficiaryEmail, new: null },
        totalAmount: { old: sponsorship.totalAmount, new: null },
      },
      performedBy,
    });

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
    throw new AppError("Sponsorship not found", 404, ErrorCodes.NOT_FOUND);
  }

  if (sponsorship.status === "CANCELLED") {
    throw new AppError(
      "Cannot link a cancelled sponsorship",
      400,
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
      ErrorCodes.REGISTRATION_NOT_FOUND,
    );
  }

  // Verify same event
  if (sponsorship.eventId !== registration.eventId) {
    throw new AppError(
      "Sponsorship and registration must be for the same event",
      400,
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

    const changes: Record<string, { old: unknown; new: unknown }> = {
      registrationId: { old: null, new: registrationId },
      amountApplied: { old: 0, new: applicableAmount },
      sponsorshipAmount: {
        old: registration.sponsorshipAmount,
        new: newSponsorshipAmount,
      },
    };
    if (sponsorship.status !== "USED") {
      changes.status = { old: sponsorship.status, new: "USED" };
    }

    await auditLog(tx, {
      entityType: "Sponsorship",
      entityId: sponsorshipId,
      action: "LINK_TO_REGISTRATION",
      changes,
      performedBy: adminUserId,
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
      ErrorCodes.REGISTRATION_NOT_FOUND,
    );
  }

  const sponsorship = await getSponsorshipByCode(registration.eventId, code);

  if (!sponsorship) {
    throw new AppError(
      `Code ${code} not found for this event`,
      404,
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
  performedBy?: string,
): Promise<void> {
  await unlinkSponsorshipFromRegistrationInternal(
    prisma,
    sponsorshipId,
    registrationId,
    performedBy,
  );
}

/**
 * Internal unlink function that works with transaction client.
 */
async function unlinkSponsorshipFromRegistrationInternal(
  tx: TxClient,
  sponsorshipId: string,
  registrationId: string,
  performedBy?: string,
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
      ErrorCodes.NOT_FOUND,
    );
  }

  const registrationBefore = await tx.registration.findUnique({
    where: { id: registrationId },
    select: {
      sponsorshipAmount: true,
      paymentMethod: true,
    },
  });

  const sponsorshipBefore = await tx.sponsorship.findUnique({
    where: { id: sponsorshipId },
    select: { status: true },
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

  const newSponsorshipAmount = calculateTotalSponsorshipAmount(remainingUsages);

  await tx.registration.update({
    where: { id: registrationId },
    data: {
      sponsorshipAmount: newSponsorshipAmount,
      ...(newSponsorshipAmount === 0 && { paymentMethod: null }),
    },
  });

  const sponsorshipUsageCount = await tx.sponsorshipUsage.count({
    where: { sponsorshipId },
  });

  let nextSponsorshipStatus = sponsorshipBefore?.status ?? null;
  if (sponsorshipBefore) {
    const newStatus = determineSponsorshipStatus(
      { status: sponsorshipBefore.status },
      sponsorshipUsageCount,
    );

    if (newStatus !== sponsorshipBefore.status) {
      await tx.sponsorship.update({
        where: { id: sponsorshipId },
        data: { status: newStatus },
      });
      nextSponsorshipStatus = newStatus;
    }
  }

  const changes: Record<string, { old: unknown; new: unknown }> = {
    registrationId: { old: registrationId, new: null },
    amountApplied: { old: usage.amountApplied, new: 0 },
    sponsorshipAmount: {
      old: registrationBefore?.sponsorshipAmount ?? null,
      new: newSponsorshipAmount,
    },
  };

  if (
    (registrationBefore?.paymentMethod ?? null) !==
    (newSponsorshipAmount === 0
      ? null
      : (registrationBefore?.paymentMethod ?? null))
  ) {
    changes.paymentMethod = {
      old: registrationBefore?.paymentMethod ?? null,
      new:
        newSponsorshipAmount === 0
          ? null
          : (registrationBefore?.paymentMethod ?? null),
    };
  }

  if (
    sponsorshipBefore &&
    nextSponsorshipStatus &&
    nextSponsorshipStatus !== sponsorshipBefore.status
  ) {
    changes.status = {
      old: sponsorshipBefore.status,
      new: nextSponsorshipStatus,
    };
  }

  await auditLog(tx, {
    entityType: "Sponsorship",
    entityId: sponsorshipId,
    action: "UNLINK_FROM_REGISTRATION",
    changes,
    performedBy,
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
