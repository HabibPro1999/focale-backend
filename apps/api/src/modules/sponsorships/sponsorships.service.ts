import { Injectable } from "@nestjs/common";
import {
  ErrorCodes,
  getSponsorshipMode,
  getSponsorshipSettings,
  type AvailableSponsorship,
  type CreateBatchResult,
  type CreateSponsorshipBatchInput,
  type LinkSponsorshipResult,
  type ListSponsorshipsQuery,
  type UpdateSponsorshipInput,
} from "@app/contracts";
import {
  calculateSettlement,
  isFullySponsored as hasFullSponsorship,
  withSponsorshipTotal,
  type RegistrationForCalculation,
} from "@app/shared";
import {
  casSetSponsorshipUsed,
  countUsagesForSponsorship,
  deleteSponsorshipRow,
  deleteUsage,
  enqueueSponsorshipEmailOutbox,
  enqueueTriggeredEmailOutbox,
  findActiveEventAccess,
  findEventForBatch,
  findRegistrationForLink,
  findRegistrationSettlementState,
  findRegistrationsForBatch,
  findSponsorFormById,
  findSponsorshipForLink,
  findSponsorshipForMutation,
  findSponsorshipForRecalc,
  findSponsorshipUnlinkState,
  findUsage,
  findUsageAmountsByRegistration,
  getActiveSponsorForm,
  getDb,
  getSponsorshipEventPricing,
  getFormSchema,
  getLinkedSponsorships,
  getPendingSponsorships,
  getRegistrationCoverage,
  getRegistrationForSponsorship,
  getSponsorshipById,
  getSponsorshipByCode,
  getSponsorshipClientId,
  insertSponsorship,
  insertSponsorshipBatch,
  insertUsage,
  listSponsorships,
  lockRegistrationForUpdate,
  lockRegistrationsForUpdate,
  lockSponsorshipForUpdate,
  searchRegistrantsForSponsorship,
  sponsorshipCodeExists,
  updateRegistrationSettlement,
  updateSponsorshipRow,
  updateUsageAmount,
  withLockingTxn,
  withTxn,
  type AccessItemForOverlap,
  type DbExecutor,
  type RegistrationForBatch,
  type SponsorshipRow,
  type SponsorshipWithUsages,
} from "@app/db";
import {
  buildBatchEmailContext,
  buildLinkedSponsorshipContext,
} from "@app/integrations";
import {
  assertEventOpen,
  assertEventWritable,
} from "../events";
import { assertModuleEnabledForClient } from "../clients/module-gates";
import { AccessService } from "../access/access.service";
import { notFound, badRequest, conflict } from "../../core/app-exception";
import {
  applicableAmountFor,
  calculateTotalSponsorshipAmount,
  detectCoverageOverlap,
  determineSponsorshipStatus,
  generateUniqueCode,
  validateCoveredAccessTimeOverlap,
  type ExistingUsage,
} from "./sponsorships.utils";

const MODULE = "sponsorships";

function toEmailEvent(event: Parameters<typeof buildLinkedSponsorshipContext>[0]["event"]) {
  return {
    name: event.name, slug: event.slug, startDate: event.startDate,
    location: event.location, client: { name: event.client.name },
  };
}

function enqueueRegistrantSponsorshipEmail(
  tx: DbExecutor,
  options: {
    trigger: "SPONSORSHIP_LINKED" | "SPONSORSHIP_PARTIAL" | "SPONSORSHIP_APPLIED";
    eventId: string;
    registration: { id: string; email: string; firstName: string | null };
    beneficiaryName: string;
    context: ReturnType<typeof buildLinkedSponsorshipContext>;
    dedupeSuffix: string;
  },
) {
  const { trigger, eventId, registration, beneficiaryName, context, dedupeSuffix } = options;
  return enqueueSponsorshipEmailOutbox(tx, {
    trigger, eventId,
    input: {
      recipientEmail: registration.email,
      recipientName: registration.firstName || beneficiaryName,
      context: context as Record<string, unknown>, registrationId: registration.id,
    },
  }, `email:sponsorship:${trigger}:${registration.id}:${dedupeSuffix}`);
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return true;
    seen.add(value);
    return false;
  });
}

/** Legacy link/batch precedence: PAID/WAIVED sticky, else SPONSORED/PARTIAL/unchanged. */
function nextStatusOnApply(
  current: string,
  isFullySponsored: boolean,
  amount: number,
): string {
  if (current === "PAID" || current === "WAIVED") return current;
  if (isFullySponsored) return "SPONSORED";
  if (amount > 0) return "PARTIAL";
  return current;
}

function sumAccessPrices(
  coveredAccessIds: string[],
  accessPriceMap: Map<string, number>,
): number {
  return coveredAccessIds.reduce(
    (sum, id) => sum + (accessPriceMap.get(id) ?? 0),
    0,
  );
}

interface BatchContext {
  event: Awaited<ReturnType<typeof findEventForBatch>> & object;
  formId: string;
  pricing: { basePrice: number; currency: string } | null;
  accessItems: AccessItemForOverlap[];
  isLinkedMode: boolean;
  beneficiaries: CreateSponsorshipBatchInput["beneficiaries"];
  linkedBeneficiaries: CreateSponsorshipBatchInput["linkedBeneficiaries"];
  registrations: Map<string, RegistrationForBatch>;
}

/** Auto-approved linked-mode entry captured for post-create email enqueue. */
interface LinkedEmailEntry {
  amountApplied: number;
  isFullySponsored: boolean;
  sponsorship: {
    code: string;
    beneficiaryName: string;
    coversBasePrice: boolean;
    coveredAccessIds: string[];
    totalAmount: number;
  };
  registration: RegistrationForBatch;
}

@Injectable()
export class SponsorshipsService {
  constructor(private readonly access: AccessService) {}

  // ==========================================================================
  // Reads
  // ==========================================================================

  listSponsorships(eventId: string, query: ListSponsorshipsQuery) {
    return listSponsorships(eventId, query);
  }

  getSponsorshipById(id: string) {
    return getSponsorshipById(id);
  }

  getSponsorshipClientId(id: string): Promise<string | null> {
    return getSponsorshipClientId(id);
  }

  getLinkedSponsorships(registrationId: string) {
    return getLinkedSponsorships(registrationId);
  }

  getActiveSponsorForm(eventId: string) {
    return getActiveSponsorForm(eventId);
  }

  searchRegistrantsForSponsorship(
    eventId: string,
    opts: { query: string; unpaidOnly: boolean; limit: number },
  ) {
    return searchRegistrantsForSponsorship(eventId, opts);
  }

  async getAvailableSponsorships(
    eventId: string,
    registrationId: string,
  ): Promise<AvailableSponsorship[]> {
    const registration = await getRegistrationCoverage(registrationId);
    if (!registration) {
      throw notFound("Registration not found", { code: ErrorCodes.REGISTRATION_NOT_FOUND });
    }
    if (registration.eventId !== eventId) {
      throw badRequest("Registration does not belong to this event", { code: ErrorCodes.BAD_REQUEST });
    }

    const pending = await getPendingSponsorships(eventId);
    const existingUsages: ExistingUsage[] = registration.existingUsages;
    return pending.map((sponsorship) => {
      const coverage = {
        coversBasePrice: sponsorship.coversBasePrice,
        coveredAccessIds: sponsorship.coveredAccessIds,
        totalAmount: sponsorship.totalAmount,
      };
      const applicableAmount = applicableAmountFor(coverage, registration);
      const conflicts = detectCoverageOverlap(existingUsages, coverage);
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

  // ==========================================================================
  // Update / cancel / delete (own locking READ COMMITTED txn)
  // ==========================================================================

  async updateSponsorship(
    id: string,
    input: UpdateSponsorshipInput,
  ): Promise<SponsorshipWithUsages> {
    if (input.status === "CANCELLED") {
      return this.cancelSponsorship(id);
    }
    await withLockingTxn((tx) => this.updateSponsorshipCore(tx, id, input));
    return (await getSponsorshipById(id)) as SponsorshipWithUsages;
  }

  private async findSponsorshipForLockedMutation(tx: DbExecutor, id: string) {
    await lockSponsorshipForUpdate(tx, id);
    const before = await findSponsorshipForMutation(tx, id);
    if (!before) return null;
    // Discover ids under the sponsorship lock; lock the complete registration
    // set in id order before any settlement/counter writes, then re-read.
    await lockRegistrationsForUpdate(
      tx,
      before.usages.flatMap((usage) => usage.registrationId ? [usage.registrationId] : []),
    );
    return findSponsorshipForMutation(tx, id);
  }

  private async updateSponsorshipCore(
    tx: DbExecutor,
    id: string,
    input: UpdateSponsorshipInput,
  ): Promise<void> {
    const sponsorship = await this.findSponsorshipForLockedMutation(tx, id);
    if (!sponsorship) {
      throw notFound("Sponsorship not found");
    }
    assertEventWritable(sponsorship.event);
    assertModuleEnabledForClient(sponsorship.event.client, MODULE);

    const coverageChanged =
      input.coversBasePrice !== undefined ||
      input.coveredAccessIds !== undefined;
    const nextCoversBasePrice =
      input.coversBasePrice ?? sponsorship.coversBasePrice;
    const nextCoveredAccessIds =
      input.coveredAccessIds ?? sponsorship.coveredAccessIds ?? [];

    // Fetch active access rows once when we need them (overlap and/or repricing).
    const needAccess =
      nextCoveredAccessIds.length > 0 && coverageChanged;
    const accessRows = needAccess
      ? await findActiveEventAccess(tx, sponsorship.eventId, nextCoveredAccessIds)
      : [];

    if (input.coveredAccessIds !== undefined && nextCoveredAccessIds.length >= 2) {
      const timeErrors = validateCoveredAccessTimeOverlap(
        nextCoveredAccessIds,
        accessRows,
      );
      if (timeErrors.length > 0) {
        throw badRequest(`Time conflicts in covered access items: ${timeErrors.join("; ")}`, { code: ErrorCodes.BAD_REQUEST, details: { timeConflicts: timeErrors } });
      }
    }

    let nextTotalAmount = sponsorship.totalAmount;
    if (coverageChanged) {
      nextTotalAmount = 0;
      if (nextCoversBasePrice) {
        nextTotalAmount += (await getSponsorshipEventPricing(tx, sponsorship.eventId))?.basePrice ?? 0;
      }
      nextTotalAmount += accessRows.reduce((sum, item) => sum + item.price, 0);
    }

    const patch: Parameters<typeof updateSponsorshipRow>[2] = {};
    for (const key of ["beneficiaryName", "beneficiaryEmail", "beneficiaryPhone", "beneficiaryAddress"] as const) {
      if (input[key] !== undefined) Object.assign(patch, { [key]: input[key] });
    }
    if (coverageChanged) {
      patch.coversBasePrice = nextCoversBasePrice;
      patch.coveredAccessIds = nextCoveredAccessIds;
      patch.totalAmount = nextTotalAmount;
    }

    if (Object.keys(patch).length > 0) {
      await updateSponsorshipRow(tx, id, patch);
    }
    if (coverageChanged && sponsorship.usages.length > 0) {
      await this.recalculateUsageAmounts(tx, id);
    }
    // ponytail: audit + realtime outbox omitted — deferred across this port wave.
  }

  async cancelSponsorship(
    id: string,
  ): Promise<SponsorshipWithUsages> {
    await withLockingTxn((tx) => this.cancelSponsorshipCore(tx, id));
    return (await getSponsorshipById(id)) as SponsorshipWithUsages;
  }

  private async cancelSponsorshipCore(
    tx: DbExecutor,
    id: string,
  ): Promise<void> {
    const sponsorship = await this.findSponsorshipForLockedMutation(tx, id);
    if (!sponsorship) {
      throw notFound("Sponsorship not found");
    }
    assertEventWritable(sponsorship.event);
    assertModuleEnabledForClient(sponsorship.event.client, MODULE);

    // Unconditional: unlinks lingering usages even when already CANCELLED.
    await this.unlinkSponsorshipFromAllRegistrations(
      tx,
      id,
      sponsorship.usages,
    );

    if (sponsorship.status !== "CANCELLED") {
      await updateSponsorshipRow(tx, id, { status: "CANCELLED" });
    }
  }

  async deleteSponsorship(id: string): Promise<void> {
    await withLockingTxn((tx) => this.deleteSponsorshipCore(tx, id));
  }

  private async deleteSponsorshipCore(
    tx: DbExecutor,
    id: string,
  ): Promise<void> {
    const sponsorship = await this.findSponsorshipForLockedMutation(tx, id);
    if (!sponsorship) {
      throw notFound("Sponsorship not found");
    }
    assertEventWritable(sponsorship.event);
    assertModuleEnabledForClient(sponsorship.event.client, MODULE);

    await this.unlinkSponsorshipFromAllRegistrations(
      tx,
      id,
      sponsorship.usages,
    );
    await deleteSponsorshipRow(tx, id);
  }

  // ==========================================================================
  // Batch creation (public form submit)
  // ==========================================================================

  async createSponsorshipBatch(
    eventId: string,
    formId: string,
    input: CreateSponsorshipBatchInput,
  ): Promise<CreateBatchResult> {
    // input.idempotencyKey is intentionally ignored (legacy parity — see schema).
    const { sponsor, customFields } = input;
    const context = await this.validateBatchInput(eventId, formId, input);

    return withTxn(async (tx) => {
      const batch = await insertSponsorshipBatch(tx, {
        eventId,
        formId: context.formId,
        labName: sponsor.labName,
        contactName: sponsor.contactName,
        email: sponsor.email,
        phone: sponsor.phone ?? null,
        formData: { sponsor, customFields: customFields ?? {} },
      });

      const autoApprove = getSponsorshipSettings(
        await getFormSchema(tx, context.formId),
      ).autoApproveSponsorship ?? false;

      let created: SponsorshipRow[];
      let linkedEmailEntries: LinkedEmailEntry[] = [];
      if (context.isLinkedMode) {
        const linkedResult = await this.createLinkedModeSponsorships(tx, context, {
          eventId, batchId: batch.id, autoApprove,
        });
        created = linkedResult.created;
        linkedEmailEntries = linkedResult.linkedEmailEntries;
      } else {
        created = await this.createCodeModeSponsorships(
          tx,
          eventId,
          batch.id,
          context.beneficiaries ?? [],
          context.pricing?.basePrice ?? 0,
          new Map(context.accessItems.map((item) => [item.id, item.price])),
        );
      }

      await this.queueBatchEmails(tx, context, {
        eventId, batchId: batch.id,
        batch: { ...sponsor, phone: sponsor.phone ?? null },
        autoApprove, sponsorships: created, linkedEmailEntries,
      });

      // ponytail: realtime outbox omitted — deferred across this port wave.
      return { batchId: batch.id, count: created.length };
    });
  }

  private async validateBatchInput(
    eventId: string,
    formId: string,
    input: CreateSponsorshipBatchInput,
  ): Promise<BatchContext> {
    const db = getDb();
    const beneficiaries = input.beneficiaries ?? [];
    const linkedBeneficiaries = input.linkedBeneficiaries ?? [];
    const isLinkedMode = linkedBeneficiaries.length > 0;

    if (!isLinkedMode && beneficiaries.length > 0) {
      const emails = beneficiaries.map((b) => b.email.toLowerCase());
      const dupes = duplicates(emails);
      if (dupes.length > 0) {
        throw badRequest(`Duplicate beneficiary emails: ${[...new Set(dupes)].join(", ")}`);
      }
    } else if (isLinkedMode) {
      const regIds = linkedBeneficiaries.map((b) => b.registrationId);
      const dupes = duplicates(regIds);
      if (dupes.length > 0) {
        throw badRequest("Duplicate registration IDs in linked beneficiaries");
      }
    }

    const event = await findEventForBatch(db, eventId);
    if (!event) {
      throw notFound("Event not found");
    }
    assertEventOpen(event);
    assertModuleEnabledForClient(event.client, MODULE);

    const form = await findSponsorFormById(db, formId, eventId);
    if (!form) {
      throw notFound("Sponsor form not found for this event");
    }
    const sponsorshipMode = getSponsorshipMode(form.schema);

    if (isLinkedMode && sponsorshipMode !== "LINKED_ACCOUNT") {
      throw badRequest("This sponsor form does not accept linked-account sponsorships");
    }
    if (!isLinkedMode && sponsorshipMode === "LINKED_ACCOUNT") {
      throw badRequest("This sponsor form requires linked-account sponsorships");
    }

    const pricing = await getSponsorshipEventPricing(db, eventId);

    const beneficiaryList = isLinkedMode ? linkedBeneficiaries : beneficiaries;
    const allAccessIds = new Set<string>();
    for (const b of beneficiaryList) {
      for (const id of b.coveredAccessIds) allAccessIds.add(id);
    }

    let batchAccessItems: AccessItemForOverlap[] = [];
    if (allAccessIds.size > 0) {
      const accessItems = await findActiveEventAccess(db, eventId, [
        ...allAccessIds,
      ]);
      batchAccessItems = accessItems;
      const valid = new Set(accessItems.map((a) => a.id));
      const invalid = [...allAccessIds].filter((id) => !valid.has(id));
      if (invalid.length > 0) {
        throw badRequest(`Invalid access items: ${invalid.join(", ")}`, { code: ErrorCodes.BAD_REQUEST, details: { invalidAccessIds: invalid } });
      }

      const overlapErrors: string[] = [];
      beneficiaryList.forEach((b, index) => {
        if (b.coveredAccessIds.length < 2) return;
        const errors = validateCoveredAccessTimeOverlap(
          b.coveredAccessIds,
          accessItems,
        );
        for (const e of errors) {
          overlapErrors.push(`Beneficiary #${index + 1}: ${e}`);
        }
      });
      if (overlapErrors.length > 0) {
        throw badRequest(`Time conflicts in covered access items: ${overlapErrors.join("; ")}`, { code: ErrorCodes.BAD_REQUEST, details: { timeConflicts: overlapErrors } });
      }
    }

    const registrations = new Map<string, RegistrationForBatch>();
    if (isLinkedMode) {
      const registrationIds = linkedBeneficiaries.map((b) => b.registrationId);
      const found = await findRegistrationsForBatch(db, eventId, registrationIds);
      const foundIds = new Set(found.map((r) => r.id));
      const missing = registrationIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw notFound(`Registrations not found: ${missing.join(", ")}`, { details: { missingRegistrationIds: missing } });
      }
      for (const r of found) registrations.set(r.id, r);
    }

    return {
      event,
      formId: form.id,
      pricing,
      accessItems: batchAccessItems,
      isLinkedMode,
      beneficiaries,
      linkedBeneficiaries,
      registrations,
    };
  }

  private async createCodeModeSponsorships(
    tx: DbExecutor,
    eventId: string,
    batchId: string,
    beneficiaries: NonNullable<CreateSponsorshipBatchInput["beneficiaries"]>,
    basePrice: number,
    accessPriceMap: Map<string, number>,
  ): Promise<SponsorshipRow[]> {
    const created: SponsorshipRow[] = [];
    // Sequential — unique-code generation must serialize (collision safety).
    for (const b of beneficiaries) {
      const code = await generateUniqueCode((c) => sponsorshipCodeExists(tx, c));
      const totalAmount =
        (b.coversBasePrice ? basePrice : 0) +
        sumAccessPrices(b.coveredAccessIds, accessPriceMap);
      const sponsorship = await insertSponsorship(tx, {
        batchId,
        eventId,
        code,
        status: "PENDING",
        beneficiaryName: b.name,
        beneficiaryEmail: b.email,
        beneficiaryPhone: b.phone ?? null,
        beneficiaryAddress: b.address ?? null,
        coversBasePrice: b.coversBasePrice,
        coveredAccessIds: b.coveredAccessIds,
        totalAmount,
      });
      created.push(sponsorship);
    }
    return created;
  }

  private async createLinkedModeSponsorships(
    tx: DbExecutor,
    context: BatchContext,
    run: { eventId: string; batchId: string; autoApprove: boolean },
  ): Promise<{
    created: SponsorshipRow[];
    linkedEmailEntries: LinkedEmailEntry[];
  }> {
    const { eventId, batchId, autoApprove } = run;
    const { registrations } = context;
    const linkedBeneficiaries = context.linkedBeneficiaries ?? [];
    const accessPriceMap = new Map(context.accessItems.map((item) => [item.id, item.price]));
    const created: SponsorshipRow[] = [];
    const linkedEmailEntries: LinkedEmailEntry[] = [];
    // Sequential — auto-approve mutates the in-memory running total that a later
    // beneficiary targeting the same registration must observe.
    for (const linked of linkedBeneficiaries) {
      const registration = registrations.get(linked.registrationId);
      if (!registration) {
        throw notFound("Registration not found", { code: ErrorCodes.REGISTRATION_NOT_FOUND });
      }
      const code = await generateUniqueCode((c) => sponsorshipCodeExists(tx, c));
      const beneficiaryName =
        [registration.firstName, registration.lastName]
          .filter(Boolean)
          .join(" ") || registration.email;
      const totalAmount =
        (linked.coversBasePrice ? registration.baseAmount : 0) +
        sumAccessPrices(linked.coveredAccessIds, accessPriceMap);

      const sponsorship = await insertSponsorship(tx, {
        batchId,
        eventId,
        code,
        status: autoApprove ? "USED" : "PENDING",
        beneficiaryName,
        beneficiaryEmail: registration.email,
        beneficiaryPhone: registration.phone ?? null,
        beneficiaryAddress: null,
        coversBasePrice: linked.coversBasePrice,
        coveredAccessIds: linked.coveredAccessIds,
        totalAmount,
        ...(autoApprove ? {} : { targetRegistrationId: linked.registrationId }),
      });
      if (!autoApprove) {
        created.push(sponsorship);
        continue;
      }

      const priceBreakdown =
        registration.priceBreakdown as RegistrationForCalculation["priceBreakdown"];
      const oldCovered =
        registration.paymentStatus === "PARTIAL"
          ? await this.access.getAlreadyCoveredAccessIds(linked.registrationId, tx)
          : new Set<string>();
      const applicableAmount = applicableAmountFor(
        { coversBasePrice: linked.coversBasePrice, coveredAccessIds: linked.coveredAccessIds, totalAmount },
        registration,
      );

      await insertUsage(tx, {
        sponsorshipId: sponsorship.id,
        registrationId: linked.registrationId,
        amountApplied: applicableAmount,
        appliedBy: "SYSTEM",
      });

      const updatedSponsorshipAmount = Math.min(
        registration.sponsorshipAmount + applicableAmount,
        registration.totalAmount,
      );
      const isFullySponsored =
        updatedSponsorshipAmount >= registration.totalAmount;
      const nextPaymentStatus = nextStatusOnApply(
        registration.paymentStatus,
        isFullySponsored,
        updatedSponsorshipAmount,
      );

      await updateRegistrationSettlement(tx, linked.registrationId, {
        sponsorshipAmount: updatedSponsorshipAmount,
        paymentMethod: "LAB_SPONSORSHIP",
        paymentStatus: nextPaymentStatus,
        ...(nextPaymentStatus === "SPONSORED" ? { paidAt: new Date() } : {}),
      });

      const newCovered = new Set([...oldCovered, ...linked.coveredAccessIds]);
      await this.access.syncPaidCountDelta(
        eventId,
        {
          status: registration.paymentStatus,
          priceBreakdown: registration.priceBreakdown,
          coveredAccessIds: oldCovered,
        },
        {
          status: nextPaymentStatus,
          priceBreakdown: registration.priceBreakdown,
          coveredAccessIds: newCovered,
        },
        tx,
      );

      // Mutate running total so a later beneficiary on the same reg sees it.
      registration.sponsorshipAmount = updatedSponsorshipAmount;
      created.push(sponsorship);
      linkedEmailEntries.push({
        amountApplied: applicableAmount,
        isFullySponsored,
        sponsorship: {
          code: sponsorship.code,
          beneficiaryName: sponsorship.beneficiaryName,
          coversBasePrice: sponsorship.coversBasePrice,
          coveredAccessIds: sponsorship.coveredAccessIds ?? [],
          totalAmount: sponsorship.totalAmount,
        },
        registration: { ...registration },
      });
    }
    return { created, linkedEmailEntries };
  }

  /**
   * Batch confirmation to the lab + (auto-approved linked mode) per-beneficiary
   * SPONSORSHIP_LINKED / PAYMENT_CONFIRMED / SPONSORSHIP_PARTIAL emails, all
   * enqueued on the batch transaction (legacy queueBatchEmails parity).
   */
  private async queueBatchEmails(
    tx: DbExecutor,
    context: BatchContext,
    run: {
      eventId: string;
      batchId: string;
      batch: { labName: string; contactName: string; email: string; phone: string | null };
      autoApprove: boolean;
      sponsorships: SponsorshipRow[];
      linkedEmailEntries: LinkedEmailEntry[];
    },
  ): Promise<void> {
    const { eventId, batchId, batch, autoApprove, sponsorships, linkedEmailEntries } = run;
    const currency = context.pricing?.currency ?? "TND";
    const eventForEmail = toEmailEvent(context.event);

    const batchContext = buildBatchEmailContext({
      batch,
      sponsorships: sponsorships.map((s) => ({
        beneficiaryName: s.beneficiaryName,
        beneficiaryEmail: s.beneficiaryEmail,
        totalAmount: s.totalAmount,
      })),
      event: eventForEmail,
      currency,
    });

    await enqueueSponsorshipEmailOutbox(
      tx,
      {
        trigger: "SPONSORSHIP_BATCH_SUBMITTED",
        eventId,
        input: {
          recipientEmail: batch.email,
          recipientName: batch.contactName,
          context: batchContext as Record<string, unknown>,
        },
      },
      `email:sponsorship:SPONSORSHIP_BATCH_SUBMITTED:${batchId}`,
    );

    if (!context.isLinkedMode || !autoApprove) return;

    for (const entry of linkedEmailEntries) {
      const linkedContext = buildLinkedSponsorshipContext({
        amountApplied: entry.amountApplied,
        sponsorship: {
          ...entry.sponsorship,
          batch: {
            labName: batch.labName,
            contactName: batch.contactName,
            email: batch.email,
          },
        },
        registration: entry.registration,
        event: eventForEmail,
        pricing: context.pricing
          ? { basePrice: context.pricing.basePrice }
          : null,
        accessItems: context.accessItems,
        currency,
      });

      await enqueueRegistrantSponsorshipEmail(tx, {
        trigger: "SPONSORSHIP_LINKED", eventId,
        registration: entry.registration, beneficiaryName: entry.sponsorship.beneficiaryName,
        context: linkedContext, dedupeSuffix: entry.sponsorship.code,
      });

      if (entry.isFullySponsored) {
        await enqueueTriggeredEmailOutbox(
          tx,
          {
            trigger: "PAYMENT_CONFIRMED",
            eventId,
            registration: {
              id: entry.registration.id,
              email: entry.registration.email,
              firstName: entry.registration.firstName,
              lastName: entry.registration.lastName,
            },
          },
          `email:triggered:PAYMENT_CONFIRMED:${entry.registration.id}`,
        );
      } else if (entry.registration.sponsorshipAmount > 0) {
        await enqueueRegistrantSponsorshipEmail(tx, {
          trigger: "SPONSORSHIP_PARTIAL", eventId,
          registration: entry.registration, beneficiaryName: entry.sponsorship.beneficiaryName,
          context: linkedContext, dedupeSuffix: entry.sponsorship.code,
        });
      }
    }
  }

  // ==========================================================================
  // Link / unlink (own transaction; private unlink helpers share the caller's transaction).
  // ==========================================================================

  linkSponsorshipToRegistration(
    sponsorshipId: string,
    registrationId: string,
    adminUserId: string,
  ): Promise<LinkSponsorshipResult> {
    return withLockingTxn(async (tx) => {
      await lockSponsorshipForUpdate(tx, sponsorshipId);
      await lockRegistrationForUpdate(tx, registrationId);
      const sponsorship = await findSponsorshipForLink(tx, sponsorshipId);
      if (!sponsorship) {
        throw notFound("Sponsorship not found");
      }
      assertEventWritable(sponsorship.event);
      assertModuleEnabledForClient(sponsorship.event.client, MODULE);

      if (sponsorship.status === "CANCELLED") {
        throw badRequest("Cannot link a cancelled sponsorship", { code: ErrorCodes.BAD_REQUEST, details: { code: "SPONSORSHIP_CANCELLED" } });
      }

      const registration = await findRegistrationForLink(tx, registrationId);
      if (!registration) {
        throw notFound("Registration not found", { code: ErrorCodes.REGISTRATION_NOT_FOUND });
      }
      if (sponsorship.eventId !== registration.eventId) {
        throw badRequest("Sponsorship and registration must be for the same event", { code: ErrorCodes.BAD_REQUEST });
      }

      const existingLink = await findUsage(tx, sponsorshipId, registrationId);
      if (existingLink) {
        throw conflict("Sponsorship is already linked to this registration", { details: { code: "SPONSORSHIP_ALREADY_LINKED" } });
      }

      const coverage = {
        coversBasePrice: sponsorship.coversBasePrice,
        coveredAccessIds: sponsorship.coveredAccessIds ?? [],
        totalAmount: sponsorship.totalAmount,
      };
      const warnings = detectCoverageOverlap(registration.existingUsages, coverage);

      const applicableAmount = applicableAmountFor(coverage, registration);

      if (applicableAmount === 0 && sponsorship.totalAmount > 0) {
        throw badRequest("Sponsorship coverage does not apply to this registration (no overlap between sponsored items and registration selections)", { code: ErrorCodes.SPONSORSHIP_NOT_APPLICABLE });
      }

      const oldCovered = await this.access.getAlreadyCoveredAccessIds(registrationId, tx);

      const usage = await insertUsage(tx, {
        sponsorshipId,
        registrationId,
        amountApplied: applicableAmount,
        appliedBy: adminUserId,
      });

      // Atomic CAS: only flips to USED while not CANCELLED.
      const casCount = await casSetSponsorshipUsed(tx, sponsorshipId);
      if (casCount === 0) {
        throw conflict("Sponsorship cannot be linked (may be cancelled or already processing)", { code: ErrorCodes.SPONSORSHIP_STATUS_CONFLICT });
      }

      const allUsages = await findUsageAmountsByRegistration(tx, registrationId);
      const newSponsorshipAmount = Math.min(
        calculateTotalSponsorshipAmount(allUsages),
        registration.totalAmount,
      );
      const isFullySponsored = newSponsorshipAmount >= registration.totalAmount;
      const nextPaymentStatus = nextStatusOnApply(
        registration.paymentStatus,
        isFullySponsored,
        newSponsorshipAmount,
      );

      await updateRegistrationSettlement(tx, registrationId, {
        sponsorshipAmount: newSponsorshipAmount,
        paymentMethod: "LAB_SPONSORSHIP",
        paymentStatus: nextPaymentStatus,
        ...(nextPaymentStatus === "SPONSORED" ? { paidAt: new Date() } : {}),
      });

      const newCovered = await this.access.getAlreadyCoveredAccessIds(registrationId, tx);
      await this.access.syncPaidCountDelta(
        registration.eventId,
        {
          status: registration.paymentStatus,
          priceBreakdown: registration.priceBreakdown,
          coveredAccessIds: oldCovered,
        },
        {
          status: nextPaymentStatus,
          priceBreakdown: registration.priceBreakdown,
          coveredAccessIds: newCovered,
        },
        tx,
      );

      // SPONSORSHIP_APPLIED email — enqueued on the same txn (legacy parity).
      const [pricing, accessItems] = await Promise.all([
        getSponsorshipEventPricing(tx, sponsorship.eventId),
        findActiveEventAccess(
          tx,
          sponsorship.eventId,
          sponsorship.coveredAccessIds ?? [],
        ),
      ]);
      const currency = pricing?.currency ?? "TND";
      const emailContext = buildLinkedSponsorshipContext({
        amountApplied: usage.amountApplied,
        sponsorship: {
          code: sponsorship.code,
          beneficiaryName: sponsorship.beneficiaryName,
          coversBasePrice: sponsorship.coversBasePrice,
          coveredAccessIds: sponsorship.coveredAccessIds ?? [],
          totalAmount: sponsorship.totalAmount,
          batch: {
            labName: sponsorship.batch.labName,
            contactName: sponsorship.batch.contactName,
            email: sponsorship.batch.email,
          },
        },
        registration: { ...registration, sponsorshipAmount: newSponsorshipAmount },
        event: toEmailEvent(sponsorship.event),
        pricing: pricing ? { basePrice: pricing.basePrice } : null,
        accessItems,
        currency,
      });
      await enqueueRegistrantSponsorshipEmail(tx, {
        trigger: "SPONSORSHIP_APPLIED", eventId: sponsorship.eventId,
        registration, beneficiaryName: sponsorship.beneficiaryName,
        context: emailContext, dedupeSuffix: sponsorshipId,
      });

      // ponytail: audit + realtime outbox omitted — deferred across this port wave.

      return {
        usage: {
          id: usage.id,
          sponsorshipId: usage.sponsorshipId,
          amountApplied: usage.amountApplied,
        },
        registration: {
          totalAmount: registration.totalAmount,
          sponsorshipAmount: newSponsorshipAmount,
          amountDue: calculateSettlement({
            totalAmount: registration.totalAmount,
            paidAmount: registration.paidAmount,
            sponsorshipAmount: newSponsorshipAmount,
          }).amountDue,
        },
        warnings,
      };
    });
  }

  async linkSponsorshipByCode(
    registrationId: string,
    code: string,
    adminUserId: string,
  ): Promise<LinkSponsorshipResult> {
    const registration = await getRegistrationForSponsorship(registrationId);
    if (!registration) {
      throw notFound("Registration not found", { code: ErrorCodes.REGISTRATION_NOT_FOUND });
    }
    const sponsorship = await getSponsorshipByCode(registration.event.id, code);
    if (!sponsorship) {
      throw notFound(`Code ${code} not found for this event`, { details: { code: "SPONSORSHIP_NOT_FOUND" } });
    }
    return this.linkSponsorshipToRegistration(
      sponsorship.id,
      registrationId,
      adminUserId,
    );
  }

  unlinkSponsorshipFromRegistration(
    sponsorshipId: string,
    registrationId: string,
  ): Promise<void> {
    return withLockingTxn((tx) =>
      this.unlinkSponsorshipFromRegistrationInternal(
        tx,
        sponsorshipId,
        registrationId,
        ),
    );
  }

  private async unlinkSponsorshipFromRegistrationInternal(
    tx: DbExecutor,
    sponsorshipId: string,
    registrationId: string,
  ): Promise<void> {
    await lockSponsorshipForUpdate(tx, sponsorshipId);
    await lockRegistrationForUpdate(tx, registrationId);
    const usage = await findUsage(tx, sponsorshipId, registrationId);
    if (!usage) {
      throw notFound("Sponsorship is not linked to this registration");
    }

    const registrationBefore = await findRegistrationSettlementState(
      tx,
      registrationId,
    );
    const sponsorshipBefore = await findSponsorshipUnlinkState(tx, sponsorshipId);
    if (sponsorshipBefore) {
      assertEventWritable(sponsorshipBefore.event);
      assertModuleEnabledForClient(sponsorshipBefore.event.client, MODULE);
    }

    const oldCovered = registrationBefore
      ? await this.access.getAlreadyCoveredAccessIds(registrationId, tx)
      : new Set<string>();

    await deleteUsage(tx, usage.id);

    const remaining = await findUsageAmountsByRegistration(tx, registrationId);
    const rawNew = calculateTotalSponsorshipAmount(remaining);
    const newSponsorshipAmount = registrationBefore
      ? Math.min(rawNew, registrationBefore.totalAmount)
      : rawNew;

    const paidAmount = registrationBefore?.paidAmount ?? 0;
    const totalAmount = registrationBefore?.totalAmount ?? 0;
    const currentStatus = registrationBefore?.paymentStatus ?? "PENDING";

    let nextStatus: string | undefined;
    if (currentStatus === "SPONSORED" && newSponsorshipAmount < totalAmount) {
      nextStatus =
        paidAmount > 0 || newSponsorshipAmount > 0 ? "PARTIAL" : "PENDING";
    } else if (currentStatus === "PARTIAL" && newSponsorshipAmount === 0) {
      nextStatus = paidAmount > 0 ? "PARTIAL" : "PENDING";
    }

    if (registrationBefore) {
      const newCovered = await this.access.getAlreadyCoveredAccessIds(registrationId, tx);
      await this.access.syncPaidCountDelta(
        registrationBefore.eventId,
        {
          status: currentStatus,
          priceBreakdown: registrationBefore.priceBreakdown,
          coveredAccessIds: oldCovered,
        },
        {
          status: nextStatus ?? currentStatus,
          priceBreakdown: registrationBefore.priceBreakdown,
          coveredAccessIds: newCovered,
        },
        tx,
      );
    }

    await updateRegistrationSettlement(tx, registrationId, {
      sponsorshipAmount: newSponsorshipAmount,
      ...(newSponsorshipAmount === 0 ? { paymentMethod: null } : {}),
      ...(nextStatus !== undefined
        ? {
            paymentStatus: nextStatus,
            ...(paidAmount === 0 ? { paidAt: null } : {}),
          }
        : {}),
    });

    const usageCount = await countUsagesForSponsorship(tx, sponsorshipId);
    if (sponsorshipBefore) {
      const newStatus = determineSponsorshipStatus(
        { status: sponsorshipBefore.status },
        usageCount,
      );
      if (newStatus !== sponsorshipBefore.status) {
        await updateSponsorshipRow(tx, sponsorshipId, { status: newStatus });
      }
    }
    // ponytail: audit omitted — deferred across this port wave.
  }

  private async unlinkSponsorshipFromAllRegistrations(
    tx: DbExecutor,
    sponsorshipId: string,
    usages: Array<{ registrationId: string | null }>,
  ): Promise<void> {
    // Sequential — each unlink recomputes state the next iteration reads.
    for (const usage of usages) {
      if (!usage.registrationId) continue;
      await this.unlinkSponsorshipFromRegistrationInternal(
        tx,
        sponsorshipId,
        usage.registrationId,
        );
    }
  }

  // ==========================================================================
  // Recalculation — runs inside the caller's locking transaction.
  // ==========================================================================

  private async recalculateUsageAmounts(
    tx: DbExecutor,
    sponsorshipId: string,
  ): Promise<void> {
    await lockSponsorshipForUpdate(tx, sponsorshipId);
    const before = await findSponsorshipForRecalc(tx, sponsorshipId);
    if (!before) return;
    await lockRegistrationsForUpdate(
      tx,
      before.usages.flatMap((usage) => usage.registration ? [usage.registration.id] : []),
    );
    const sponsorship = await findSponsorshipForRecalc(tx, sponsorshipId);
    if (!sponsorship) return;

    // Sequential — each iteration re-reads the running total for its registration.
    for (const usage of sponsorship.usages) {
      const registration = usage.registration;
      if (!registration) continue;

      const priceBreakdown =
        registration.priceBreakdown as RegistrationForCalculation["priceBreakdown"];
      const newAmount = applicableAmountFor(sponsorship, registration);

      await updateUsageAmount(tx, usage.id, newAmount);

      const allUsages = await findUsageAmountsByRegistration(tx, registration.id);
      const totalSponsorshipAmount = Math.min(
        calculateTotalSponsorshipAmount(allUsages),
        registration.totalAmount,
      );
      const oldPaymentStatus = registration.paymentStatus;
      const settlement = calculateSettlement({
        totalAmount: registration.totalAmount,
        paidAmount: registration.paidAmount,
        sponsorshipAmount: totalSponsorshipAmount,
      });
      const nextPaymentStatus =
        oldPaymentStatus === "PAID" ||
        oldPaymentStatus === "WAIVED" ||
        oldPaymentStatus === "REFUNDED"
          ? oldPaymentStatus
          : hasFullSponsorship({ sponsorshipAmount: totalSponsorshipAmount, totalAmount: registration.totalAmount })
            ? "SPONSORED"
            : settlement.isPartiallyPaid
              ? "PARTIAL"
              : "PENDING";
      const nextPaidAt =
        nextPaymentStatus === "SPONSORED"
          ? (registration.paidAt ?? new Date())
          : nextPaymentStatus === "PARTIAL" || nextPaymentStatus === "PENDING"
            ? null
            : registration.paidAt;
      const subtotal =
        (priceBreakdown as { subtotal?: number }).subtotal ??
        registration.totalAmount;
      const updatedPriceBreakdown = withSponsorshipTotal(priceBreakdown, subtotal, totalSponsorshipAmount);

      await updateRegistrationSettlement(tx, registration.id, {
        sponsorshipAmount: totalSponsorshipAmount,
        paymentStatus: nextPaymentStatus,
        paidAt: nextPaidAt,
        priceBreakdown: updatedPriceBreakdown,
      });

      if (oldPaymentStatus !== nextPaymentStatus) {
        const oldCovered =
          oldPaymentStatus === "PARTIAL"
            ? await this.access.getAlreadyCoveredAccessIds(
                registration.id,
                tx,
                sponsorshipId,
              )
            : new Set<string>();
        const newCovered =
          nextPaymentStatus === "PARTIAL"
            ? await this.access.getAlreadyCoveredAccessIds(registration.id, tx)
            : new Set<string>();
        await this.access.syncPaidCountDelta(
          registration.eventId,
          {
            status: oldPaymentStatus,
            priceBreakdown,
            coveredAccessIds: oldCovered,
          },
          {
            status: nextPaymentStatus,
            priceBreakdown: updatedPriceBreakdown,
            coveredAccessIds: newCovered,
          },
          tx,
        );
      }
    }
  }
}
