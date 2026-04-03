import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { logger } from "@shared/utils/logger.js";
import {
  generateUniqueCode,
  calculateApplicableAmount,
  validateCoveredAccessTimeOverlap,
  type RegistrationForCalculation,
} from "./sponsorships.utils.js";
import type {
  CreateSponsorshipBatchInput,
  BeneficiaryInput,
  LinkedBeneficiaryInput,
} from "./sponsorships.schema.js";
import type { Prisma, Sponsorship } from "@/generated/prisma/client.js";
import type { TxClient } from "@shared/types/prisma.js";
import {
  queueSponsorshipEmail,
  queueTriggeredEmail,
  buildBatchEmailContext,
  buildLinkedSponsorshipContext,
} from "@email";

// ============================================================================
// Types
// ============================================================================

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

export interface CreateBatchResult {
  batchId: string;
  count: number;
}

// ============================================================================
// Private Helpers
// ============================================================================

function calculateCoveredAccessTotal(
  coveredAccessIds: string[],
  accessPriceMap: Map<string, number>,
): number {
  return coveredAccessIds.reduce(
    (sum, accessId) => sum + (accessPriceMap.get(accessId) ?? 0),
    0,
  );
}

async function validateBatchInput(
  eventId: string,
  formId: string,
  input: CreateSponsorshipBatchInput,
): Promise<BatchValidationContext> {
  const { beneficiaries = [], linkedBeneficiaries = [] } = input;
  const isLinkedMode = linkedBeneficiaries.length > 0;

  // Check for duplicate beneficiaries
  if (!isLinkedMode && beneficiaries.length > 0) {
    const emails = beneficiaries.map((b) => b.email.toLowerCase());
    const duplicateEmails = emails.filter((e, i) => emails.indexOf(e) !== i);
    if (duplicateEmails.length > 0) {
      throw new AppError(
        `Duplicate beneficiary emails: ${[...new Set(duplicateEmails)].join(", ")}`,
        400,
        ErrorCodes.VALIDATION_ERROR,
      );
    }
  }

  if (isLinkedMode && linkedBeneficiaries.length > 0) {
    const regIds = linkedBeneficiaries.map((b) => b.registrationId);
    const duplicateRegIds = regIds.filter((r, i) => regIds.indexOf(r) !== i);
    if (duplicateRegIds.length > 0) {
      throw new AppError(
        "Duplicate registration IDs in linked beneficiaries",
        400,
        ErrorCodes.VALIDATION_ERROR,
      );
    }
  }

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
    select: { id: true, schema: true },
  });

  if (!form) {
    throw new AppError(
      "Sponsor form not found for this event",
      404,
      ErrorCodes.NOT_FOUND,
    );
  }

  const sponsorshipMode =
    (
      (form.schema as Record<string, unknown> | null)?.sponsorshipSettings as
        | Record<string, unknown>
        | undefined
    )?.sponsorshipMode ?? "CODE";

  if (isLinkedMode && sponsorshipMode !== "LINKED_ACCOUNT") {
    throw new AppError(
      "This sponsor form does not accept linked-account sponsorships",
      400,
      ErrorCodes.VALIDATION_ERROR,
    );
  }

  if (!isLinkedMode && sponsorshipMode === "LINKED_ACCOUNT") {
    throw new AppError(
      "This sponsor form requires linked-account sponsorships",
      400,
      ErrorCodes.VALIDATION_ERROR,
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
    const beneficiaryName =
      [registration.firstName, registration.lastName]
        .filter(Boolean)
        .join(" ") || registration.email;
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
          beneficiaryName: beneficiaryName,
          beneficiaryEmail: registration.email,
          beneficiaryPhone: registration.phone ?? null,
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
        beneficiaryName: beneficiaryName,
        beneficiaryEmail: registration.email,
        beneficiaryPhone: registration.phone ?? null,
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

    const updatedSponsorshipAmount = Math.min(
      registration.sponsorshipAmount + applicableAmount,
      registration.totalAmount,
    );
    const isFullySponsored =
      updatedSponsorshipAmount >= registration.totalAmount;

    await tx.registration.update({
      where: { id: linked.registrationId },
      data: {
        sponsorshipAmount: updatedSponsorshipAmount,
        paymentMethod: "LAB_SPONSORSHIP",
        // Fully sponsored → SPONSORED; partially → PARTIAL
        ...(isFullySponsored
          ? { paymentStatus: "SPONSORED", paidAt: new Date() }
          : updatedSponsorshipAmount > 0
            ? { paymentStatus: "PARTIAL" }
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
      false;

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
