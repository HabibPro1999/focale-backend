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
  queueTriggeredEmail,
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

type AccessItem = {
  id: string;
  name: string;
  price: number;
  type: string;
  groupLabel: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
};

type RegistrationData = {
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

type SponsorshipWithLink = Sponsorship & { linkedRegistrationId?: string };

type SponsorshipCoverage = {
  registration: RegistrationData;
  sponsorship: SponsorshipWithLink;
  updatedAmount: number;
  status: "full" | "partial";
};

type TransactionClient = Parameters<
  Parameters<typeof prisma.$transaction>[0]
>[0];

type EventInfo = {
  id: string;
  name: string;
  slug: string;
  status: string;
  startDate: Date;
  location: string | null;
  client: { name: string };
};

type BatchInfo = {
  labName: string;
  contactName: string;
  email: string;
  phone: string | null;
};

// ============================================================================
// Private Helpers
// ============================================================================

function validateBatchDuplicates(
  isLinkedMode: boolean,
  beneficiaries: BeneficiaryInput[] | undefined,
  linkedBeneficiaries: LinkedBeneficiaryInput[] | undefined,
): void {
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
}

async function validateAndFetchAccessItems(
  beneficiaryList: Array<{ coveredAccessIds: string[] }>,
  eventId: string,
): Promise<AccessItem[]> {
  const allAccessIds = new Set<string>();
  for (const b of beneficiaryList) for (const id of b.coveredAccessIds) allAccessIds.add(id);
  if (allAccessIds.size === 0) return [];

  const accessItems = await prisma.eventAccess.findMany({
    where: { id: { in: Array.from(allAccessIds) }, eventId, active: true },
    select: { id: true, name: true, price: true, type: true, groupLabel: true, startsAt: true, endsAt: true },
  });

  const validIds = new Set(accessItems.map((a) => a.id));
  const invalidIds = Array.from(allAccessIds).filter((id) => !validIds.has(id));
  if (invalidIds.length > 0) {
    throw new AppError(`Invalid access items: ${invalidIds.join(", ")}`, 400, true, ErrorCodes.BAD_REQUEST, { invalidAccessIds: invalidIds });
  }

  const overlapErrors: string[] = [];
  beneficiaryList.forEach((b, index) => {
    if (b.coveredAccessIds.length >= 2) {
      const errors = validateCoveredAccessTimeOverlap(
        b.coveredAccessIds,
        accessItems.map((item) => ({ id: item.id, name: item.name, type: item.type, groupLabel: item.groupLabel, startsAt: item.startsAt, endsAt: item.endsAt })),
      );
      for (const error of errors) overlapErrors.push(`Beneficiary #${index + 1}: ${error}`);
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
  return accessItems;
}

async function fetchAndValidateLinkedRegistrations(
  linkedBeneficiaries: LinkedBeneficiaryInput[],
  eventId: string,
): Promise<Map<string, RegistrationData>> {
  const registrationIds = linkedBeneficiaries.map((b) => b.registrationId);
  const foundRegistrations = await prisma.registration.findMany({
    where: { id: { in: registrationIds }, eventId },
    select: {
      id: true, email: true, firstName: true, lastName: true, phone: true,
      totalAmount: true, sponsorshipAmount: true, baseAmount: true,
      accessTypeIds: true, priceBreakdown: true, linkBaseUrl: true, editToken: true,
    },
  });

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

  const registrations = new Map<string, RegistrationData>();
  for (const reg of foundRegistrations) registrations.set(reg.id, reg);
  return registrations;
}

async function createCodeModeSponsorships(
  tx: TransactionClient,
  beneficiaries: BeneficiaryInput[],
  batchId: string,
  eventId: string,
): Promise<SponsorshipWithLink[]> {
  const created: SponsorshipWithLink[] = [];
  for (const b of beneficiaries) {
    const code = await generateUniqueCode(tx);
    const totalAmount = await calculateSponsorshipTotal(tx, eventId, b.coversBasePrice, b.coveredAccessIds);
    const sponsorship = await tx.sponsorship.create({
      data: {
        batchId, eventId, code, status: "PENDING",
        beneficiaryName: b.name, beneficiaryEmail: b.email,
        beneficiaryPhone: b.phone ?? null, beneficiaryAddress: b.address ?? null,
        coversBasePrice: b.coversBasePrice, coveredAccessIds: b.coveredAccessIds,
        totalAmount, nominalAmount: totalAmount,
      },
    });
    created.push(sponsorship);
  }
  return created;
}

async function autoLinkSponsorshipToRegistration(
  tx: TransactionClient,
  linked: LinkedBeneficiaryInput,
  registration: RegistrationData,
  batchId: string,
  eventId: string,
  code: string,
  totalAmount: number,
  cumulativeAmounts: Map<string, number>,
): Promise<{ sponsorship: SponsorshipWithLink; skipped: boolean }> {
  if (!cumulativeAmounts.has(linked.registrationId)) {
    cumulativeAmounts.set(linked.registrationId, registration.sponsorshipAmount);
  }
  const existingUsages = await tx.sponsorshipUsage.findMany({
    where: { registrationId: linked.registrationId },
    include: { sponsorship: { select: { code: true, coversBasePrice: true, coveredAccessIds: true } } },
  });
  const overlapWarnings = detectCoverageOverlap(
    existingUsages.map((u) => ({ sponsorshipId: u.sponsorshipId, sponsorship: u.sponsorship })),
    { coversBasePrice: linked.coversBasePrice, coveredAccessIds: linked.coveredAccessIds, totalAmount: 0 },
  );
  if (overlapWarnings.length > 0) {
    logger.warn({ registrationId: linked.registrationId, beneficiaryName: linked.name, warnings: overlapWarnings }, "Coverage overlap detected in batch sponsorship linking");
  }
  const priceBreakdown = parsePriceBreakdown(registration.priceBreakdown);
  const applicableAmount = calculateApplicableAmount(
    { coversBasePrice: linked.coversBasePrice, coveredAccessIds: linked.coveredAccessIds, totalAmount },
    { totalAmount: registration.totalAmount, baseAmount: registration.baseAmount, accessTypeIds: registration.accessTypeIds, priceBreakdown },
  );
  const currentAmount = cumulativeAmounts.get(linked.registrationId)!;
  const cappedAmount = capSponsorshipAmount(applicableAmount, currentAmount, registration.totalAmount);
  if (cappedAmount === 0) {
    logger.warn({ registrationId: linked.registrationId, beneficiaryName: linked.name, applicableAmount, currentSponsorshipAmount: currentAmount }, "Skipping sponsorship link - registration is fully sponsored");
    return { sponsorship: null as unknown as SponsorshipWithLink, skipped: true };
  }
  const sponsorship = await tx.sponsorship.create({
    data: {
      batchId, eventId, code, status: "USED",
      beneficiaryName: linked.name, beneficiaryEmail: linked.email,
      beneficiaryPhone: null, beneficiaryAddress: null,
      coversBasePrice: linked.coversBasePrice, coveredAccessIds: linked.coveredAccessIds,
      totalAmount, nominalAmount: totalAmount,
    },
  });
  await tx.sponsorshipUsage.create({
    data: { sponsorshipId: sponsorship.id, registrationId: linked.registrationId, amountApplied: cappedAmount, appliedBy: "SYSTEM" },
  });
  await tx.registration.update({ where: { id: linked.registrationId }, data: { sponsorshipAmount: { increment: cappedAmount } } });
  cumulativeAmounts.set(linked.registrationId, currentAmount + cappedAmount);
  return { sponsorship: { ...sponsorship, linkedRegistrationId: linked.registrationId }, skipped: false };
}

async function processLinkedBeneficiary(
  tx: TransactionClient,
  linked: LinkedBeneficiaryInput,
  registration: RegistrationData,
  batchId: string,
  eventId: string,
  autoApprove: boolean,
  cumulativeAmounts: Map<string, number>,
): Promise<{ sponsorship: SponsorshipWithLink | null; skipped: boolean }> {
  const totalAmount = await calculateSponsorshipTotal(tx, eventId, linked.coversBasePrice, linked.coveredAccessIds);
  const code = await generateUniqueCode(tx);
  if (!autoApprove) {
    const sponsorship = await tx.sponsorship.create({
      data: {
        batchId, eventId, code, status: "PENDING",
        beneficiaryName: linked.name, beneficiaryEmail: linked.email,
        beneficiaryPhone: null, beneficiaryAddress: null,
        coversBasePrice: linked.coversBasePrice, coveredAccessIds: linked.coveredAccessIds,
        totalAmount, nominalAmount: totalAmount, targetRegistrationId: linked.registrationId,
      },
    });
    return { sponsorship: { ...sponsorship, linkedRegistrationId: linked.registrationId }, skipped: false };
  }
  return autoLinkSponsorshipToRegistration(tx, linked, registration, batchId, eventId, code, totalAmount, cumulativeAmounts);
}

async function resolveLinkedCoverageStatus(
  sponsorships: SponsorshipWithLink[],
  registrations: Map<string, RegistrationData>,
  cumulativeAmounts: Map<string, number>,
): Promise<SponsorshipCoverage[]> {
  const coverageResults: SponsorshipCoverage[] = [];
  for (const sponsorship of sponsorships) {
    const registration = registrations.get(sponsorship.linkedRegistrationId!)!;
    const updatedAmount = cumulativeAmounts.get(registration.id) ?? registration.sponsorshipAmount;
    if (updatedAmount >= registration.totalAmount) {
      await prisma.registration.update({ where: { id: registration.id }, data: { paymentStatus: "PAID", paidAt: new Date() } });
      coverageResults.push({ registration, sponsorship, updatedAmount, status: "full" });
    } else if (updatedAmount > 0) {
      coverageResults.push({ registration, sponsorship, updatedAmount, status: "partial" });
    }
  }
  return coverageResults;
}

async function queueBatchConfirmationEmail(
  eventId: string,
  batchInfo: BatchInfo,
  sponsorships: SponsorshipWithLink[],
  event: EventInfo,
  currency: string,
): Promise<void> {
  const batchContext = buildBatchEmailContext({
    batch: batchInfo,
    sponsorships: sponsorships.map((s) => ({ beneficiaryName: s.beneficiaryName, beneficiaryEmail: s.beneficiaryEmail, totalAmount: s.totalAmount })),
    event: { name: event.name, startDate: event.startDate, location: event.location, client: event.client },
    currency,
  });
  const queued = await queueSponsorshipEmail("SPONSORSHIP_BATCH_SUBMITTED", eventId, {
    recipientEmail: batchInfo.email,
    recipientName: batchInfo.contactName,
    context: batchContext,
  });
  if (!queued) {
    logger.warn({ trigger: "SPONSORSHIP_BATCH_SUBMITTED", eventId }, "No email template configured - lab will not receive confirmation email");
  }
}

async function queueLinkedSponsorshipEmails(
  eventId: string,
  sponsorships: SponsorshipWithLink[],
  registrations: Map<string, RegistrationData>,
  coverageResults: SponsorshipCoverage[],
  cumulativeAmounts: Map<string, number>,
  batchInfo: BatchInfo,
  event: EventInfo,
  pricing: { basePrice: number } | null,
  accessItems: AccessItem[],
  currency: string,
): Promise<void> {
  for (const sponsorship of sponsorships) {
    const registration = registrations.get(sponsorship.linkedRegistrationId!)!;
    const updatedSponsorshipAmount = cumulativeAmounts.get(registration.id) ?? registration.sponsorshipAmount;
    const context = buildLinkedSponsorshipContext({
      sponsorship: { code: sponsorship.code, beneficiaryName: sponsorship.beneficiaryName, coversBasePrice: sponsorship.coversBasePrice, coveredAccessIds: sponsorship.coveredAccessIds, totalAmount: sponsorship.totalAmount, batch: { labName: batchInfo.labName, contactName: batchInfo.contactName, email: batchInfo.email } },
      registration: { ...registration, phone: registration.phone ?? null, sponsorshipAmount: updatedSponsorshipAmount },
      event: { name: event.name, slug: event.slug, startDate: event.startDate, location: event.location, client: event.client },
      pricing: pricing ? { basePrice: pricing.basePrice } : null,
      accessItems,
      currency,
    });
    const linkedQueued = await queueSponsorshipEmail("SPONSORSHIP_LINKED", eventId, { recipientEmail: registration.email, recipientName: registration.firstName || sponsorship.beneficiaryName, context, registrationId: registration.id });
    if (!linkedQueued) {
      logger.warn({ trigger: "SPONSORSHIP_LINKED", eventId, registrationId: registration.id }, "No email template configured - doctor will not receive sponsorship notification");
    }
    const coverage = coverageResults.find((c) => c.registration.id === registration.id && c.sponsorship.id === sponsorship.id);
    if (coverage?.status === "full") {
      await queueTriggeredEmail("PAYMENT_CONFIRMED", eventId, { id: registration.id, email: registration.email, firstName: registration.firstName, lastName: registration.lastName });
    } else if (coverage?.status === "partial") {
      await queueSponsorshipEmail("SPONSORSHIP_PARTIAL", eventId, { recipientEmail: registration.email, recipientName: registration.firstName || sponsorship.beneficiaryName, context, registrationId: registration.id });
    }
  }
}

async function executeBatchTransaction(
  tx: TransactionClient,
  eventId: string,
  formId: string,
  sponsor: SponsorInfo,
  customFields: Record<string, unknown> | undefined,
  beneficiaries: BeneficiaryInput[] | undefined,
  linkedBeneficiaries: LinkedBeneficiaryInput[] | undefined,
  registrations: Map<string, RegistrationData>,
  isLinkedMode: boolean,
  autoApprove: boolean,
): Promise<{ batchId: string; count: number; skippedCount: number; autoApprove: boolean; batch: BatchInfo; sponsorships: SponsorshipWithLink[]; registrationSponsorshipAmounts: Map<string, number> }> {
  const batch = await tx.sponsorshipBatch.create({
    data: { eventId, formId, labName: sponsor.labName, contactName: sponsor.contactName, email: sponsor.email, phone: sponsor.phone ?? null, formData: { sponsor, customFields: customFields ?? {} } as Prisma.InputJsonValue },
  });
  const createdSponsorships: SponsorshipWithLink[] = [];
  let skippedCount = 0;
  const registrationSponsorshipAmounts = new Map<string, number>();
  if (isLinkedMode) {
    for (const linked of linkedBeneficiaries!) {
      const registration = registrations.get(linked.registrationId)!;
      const { sponsorship, skipped } = await processLinkedBeneficiary(tx, linked, registration, batch.id, eventId, autoApprove, registrationSponsorshipAmounts);
      if (skipped) { skippedCount++; continue; }
      createdSponsorships.push(sponsorship!);
    }
  } else {
    createdSponsorships.push(...await createCodeModeSponsorships(tx, beneficiaries!, batch.id, eventId));
  }
  await tx.auditLog.create({
    data: { entityType: "Sponsorship", entityId: batch.id, action: "BATCH_CREATE", changes: { count: createdSponsorships.length, mode: isLinkedMode ? "LINKED_ACCOUNT" : "CODE" }, performedBy: "PUBLIC" },
  });
  return {
    batchId: batch.id, count: createdSponsorships.length, skippedCount, autoApprove,
    batch: { labName: sponsor.labName, contactName: sponsor.contactName, email: sponsor.email, phone: sponsor.phone ?? null },
    sponsorships: createdSponsorships, registrationSponsorshipAmounts,
  };
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
  const isLinkedMode = (linkedBeneficiaries?.length ?? 0) > 0;
  const beneficiaryList = isLinkedMode ? linkedBeneficiaries! : (beneficiaries ?? []);

  validateBatchDuplicates(isLinkedMode, beneficiaries, linkedBeneficiaries);

  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, name: true, slug: true, status: true, startDate: true, location: true, client: { select: { name: true } } },
  });
  if (!event) throw new AppError("Event not found", 404, true, ErrorCodes.NOT_FOUND);

  const form = await prisma.form.findFirst({ where: { id: formId, eventId, type: "SPONSOR" }, select: { id: true, schema: true } });
  if (!form) throw new AppError("Sponsor form not found for this event", 404, true, ErrorCodes.NOT_FOUND);

  type FormSchemaWithSettings = { sponsorshipSettings?: { autoApproveSponsorship?: boolean } };
  const autoApprove = (form.schema as FormSchemaWithSettings)?.sponsorshipSettings?.autoApproveSponsorship ?? true;

  const pricing = await prisma.eventPricing.findUnique({ where: { eventId }, select: { basePrice: true, currency: true } });
  const currency = pricing?.currency ?? "TND";

  const accessItems = await validateAndFetchAccessItems(beneficiaryList, eventId);
  const registrations = isLinkedMode
    ? await fetchAndValidateLinkedRegistrations(linkedBeneficiaries!, eventId)
    : new Map<string, RegistrationData>();

  const result = await prisma.$transaction((tx) =>
    executeBatchTransaction(tx, eventId, formId, sponsor, customFields, beneficiaries, linkedBeneficiaries, registrations, isLinkedMode, autoApprove),
  );

  const coverageResults = (isLinkedMode && result.autoApprove)
    ? await resolveLinkedCoverageStatus(result.sponsorships, registrations, result.registrationSponsorshipAmounts)
    : [];

  try {
    await queueBatchConfirmationEmail(eventId, result.batch, result.sponsorships, event, currency);
    if (isLinkedMode && result.autoApprove) {
      await queueLinkedSponsorshipEmails(eventId, result.sponsorships, registrations, coverageResults, result.registrationSponsorshipAmounts, result.batch, event, pricing ?? null, accessItems, currency);
    }
  } catch (emailError) {
    logger.error({ error: emailError, batchId: result.batchId }, "Failed to queue sponsorship emails");
  }

  return { batchId: result.batchId, count: result.count, skippedCount: result.skippedCount };
}
