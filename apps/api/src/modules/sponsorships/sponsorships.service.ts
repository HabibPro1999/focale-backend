import { Injectable } from "@nestjs/common";
import {
  ErrorCodes,
  type AvailableSponsorship,
  type CreateBatchResult,
  type CreateSponsorshipBatchInput,
  type LinkSponsorshipResult,
  type ListSponsorshipsQuery,
  type UpdateSponsorshipInput,
} from "@app/contracts";
import {
  calculateApplicableAmount,
  calculateSettlement,
  type RegistrationForCalculation,
} from "@app/shared";
import {
  casSetSponsorshipUsed,
  countUsagesForSponsorship,
  deleteSponsorshipRow,
  deleteUsage,
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
  getAlreadyCoveredAccessIds,
  getDb,
  getEventBasePrice,
  getEventPricingForBatch,
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
  SponsorshipAccessError,
  searchRegistrantsForSponsorship,
  sponsorshipCodeExists,
  syncPaidCountDelta,
  updateRegistrationSettlement,
  updateSponsorshipRow,
  updateUsageAmount,
  withTxn,
  type DbExecutor,
  type RegistrationForBatch,
  type SponsorshipWithUsages,
} from "@app/db";
import {
  assertEventOpen,
  assertEventWritable,
} from "../events";
import { assertModuleEnabledForClient } from "../clients/module-gates";
import { AppException } from "./app-exception";
import {
  calculateTotalSponsorshipAmount,
  detectCoverageOverlap,
  determineSponsorshipStatus,
  generateUniqueCode,
  validateCoveredAccessTimeOverlap,
  type ExistingUsage,
} from "./sponsorships.utils";

const MODULE = "sponsorships";

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
  accessPriceMap: Map<string, number>;
  isLinkedMode: boolean;
  beneficiaries: CreateSponsorshipBatchInput["beneficiaries"];
  linkedBeneficiaries: CreateSponsorshipBatchInput["linkedBeneficiaries"];
  registrations: Map<string, RegistrationForBatch>;
}

@Injectable()
export class SponsorshipsService {
  /**
   * READ COMMITTED txn (no retry — legacy parity). Translates the ported
   * access-capacity error into an AppException so the filter renders the legacy
   * ACCESS_CAPACITY_EXCEEDED (409) envelope instead of a bare 500.
   */
  private async runTxn<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    try {
      return await withTxn(fn);
    } catch (err) {
      if (err instanceof SponsorshipAccessError) {
        throw new AppException(err.code, err.message, err.status, err.details);
      }
      throw err;
    }
  }

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

  getRegistrationForSponsorship(registrationId: string) {
    return getRegistrationForSponsorship(registrationId);
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
      throw new AppException(
        ErrorCodes.REGISTRATION_NOT_FOUND,
        "Registration not found",
        404,
      );
    }
    if (registration.eventId !== eventId) {
      throw new AppException(
        ErrorCodes.BAD_REQUEST,
        "Registration does not belong to this event",
        400,
      );
    }

    const pending = await getPendingSponsorships(eventId);
    const existingUsages: ExistingUsage[] = registration.existingUsages;
    const priceBreakdown =
      registration.priceBreakdown as RegistrationForCalculation["priceBreakdown"];

    return pending.map((sponsorship) => {
      const coverage = {
        coversBasePrice: sponsorship.coversBasePrice,
        coveredAccessIds: sponsorship.coveredAccessIds,
        totalAmount: sponsorship.totalAmount,
      };
      const applicableAmount = calculateApplicableAmount(coverage, {
        totalAmount: registration.totalAmount,
        baseAmount: registration.baseAmount,
        accessTypeIds: registration.accessTypeIds,
        priceBreakdown,
      });
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
  // Update / cancel / delete (own READ COMMITTED txn — no retry, legacy parity)
  // ==========================================================================

  async updateSponsorship(
    id: string,
    input: UpdateSponsorshipInput,
    performedBy?: string,
  ): Promise<SponsorshipWithUsages> {
    if (input.status === "CANCELLED") {
      return this.cancelSponsorship(id, performedBy);
    }
    await this.runTxn((tx) => this.updateSponsorshipCore(tx, id, input));
    return (await getSponsorshipById(id)) as SponsorshipWithUsages;
  }

  private async updateSponsorshipCore(
    tx: DbExecutor,
    id: string,
    input: UpdateSponsorshipInput,
  ): Promise<void> {
    const sponsorship = await findSponsorshipForMutation(tx, id);
    if (!sponsorship) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Sponsorship not found", 404);
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
      nextCoveredAccessIds.length > 0 &&
      (input.coveredAccessIds !== undefined || coverageChanged);
    const accessRows = needAccess
      ? await findActiveEventAccess(tx, sponsorship.eventId, nextCoveredAccessIds)
      : [];

    if (input.coveredAccessIds !== undefined && nextCoveredAccessIds.length >= 2) {
      const timeErrors = validateCoveredAccessTimeOverlap(
        nextCoveredAccessIds,
        accessRows,
      );
      if (timeErrors.length > 0) {
        throw new AppException(
          ErrorCodes.BAD_REQUEST,
          `Time conflicts in covered access items: ${timeErrors.join("; ")}`,
          400,
          { timeConflicts: timeErrors },
        );
      }
    }

    let nextTotalAmount = sponsorship.totalAmount;
    if (coverageChanged) {
      nextTotalAmount = 0;
      if (nextCoversBasePrice) {
        nextTotalAmount += (await getEventBasePrice(tx, sponsorship.eventId)) ?? 0;
      }
      if (nextCoveredAccessIds.length > 0) {
        nextTotalAmount += accessRows.reduce((sum, item) => sum + item.price, 0);
      }
    }

    const patch: Parameters<typeof updateSponsorshipRow>[2] = {};
    if (input.beneficiaryName !== undefined) {
      patch.beneficiaryName = input.beneficiaryName;
    }
    if (input.beneficiaryEmail !== undefined) {
      patch.beneficiaryEmail = input.beneficiaryEmail;
    }
    if (input.beneficiaryPhone !== undefined) {
      patch.beneficiaryPhone = input.beneficiaryPhone;
    }
    if (input.beneficiaryAddress !== undefined) {
      patch.beneficiaryAddress = input.beneficiaryAddress;
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
    performedBy?: string,
  ): Promise<SponsorshipWithUsages> {
    await this.runTxn((tx) => this.cancelSponsorshipCore(tx, id, performedBy));
    return (await getSponsorshipById(id)) as SponsorshipWithUsages;
  }

  private async cancelSponsorshipCore(
    tx: DbExecutor,
    id: string,
    performedBy?: string,
  ): Promise<void> {
    const sponsorship = await findSponsorshipForMutation(tx, id);
    if (!sponsorship) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Sponsorship not found", 404);
    }
    assertEventWritable(sponsorship.event);
    assertModuleEnabledForClient(sponsorship.event.client, MODULE);

    // Unconditional: unlinks lingering usages even when already CANCELLED.
    await this.unlinkSponsorshipFromAllRegistrations(
      tx,
      id,
      sponsorship.usages,
      performedBy,
    );

    if (sponsorship.status !== "CANCELLED") {
      await updateSponsorshipRow(tx, id, { status: "CANCELLED" });
    }
  }

  async deleteSponsorship(id: string, performedBy?: string): Promise<void> {
    await this.runTxn((tx) => this.deleteSponsorshipCore(tx, id, performedBy));
  }

  private async deleteSponsorshipCore(
    tx: DbExecutor,
    id: string,
    performedBy?: string,
  ): Promise<void> {
    const sponsorship = await findSponsorshipForMutation(tx, id);
    if (!sponsorship) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Sponsorship not found", 404);
    }
    assertEventWritable(sponsorship.event);
    assertModuleEnabledForClient(sponsorship.event.client, MODULE);

    await this.unlinkSponsorshipFromAllRegistrations(
      tx,
      id,
      sponsorship.usages,
      performedBy,
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
    const { sponsor, customFields } = input;
    const context = await this.validateBatchInput(eventId, formId, input);

    return this.runTxn(async (tx) => {
      const batch = await insertSponsorshipBatch(tx, {
        eventId,
        formId: context.formId,
        labName: sponsor.labName,
        contactName: sponsor.contactName,
        email: sponsor.email,
        phone: sponsor.phone ?? null,
        formData: { sponsor, customFields: customFields ?? {} },
      });

      const formSchema = (await getFormSchema(tx, context.formId)) as
        | Record<string, unknown>
        | null;
      const sponsorshipSettings = formSchema?.sponsorshipSettings as
        | Record<string, unknown>
        | undefined;
      const autoApprove =
        (sponsorshipSettings?.autoApproveSponsorship as boolean | undefined) ??
        false;

      const count = context.isLinkedMode
        ? await this.createLinkedModeSponsorships(
            tx,
            eventId,
            batch.id,
            context.linkedBeneficiaries ?? [],
            context.registrations,
            autoApprove,
            context.accessPriceMap,
          )
        : await this.createCodeModeSponsorships(
            tx,
            eventId,
            batch.id,
            context.beneficiaries ?? [],
            context.pricing?.basePrice ?? 0,
            context.accessPriceMap,
          );

      // ponytail: batch/linked emails + realtime outbox omitted — deferred.
      return { batchId: batch.id, count };
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
      const dupes = emails.filter((e, i) => emails.indexOf(e) !== i);
      if (dupes.length > 0) {
        throw new AppException(
          ErrorCodes.VALIDATION_ERROR,
          `Duplicate beneficiary emails: ${[...new Set(dupes)].join(", ")}`,
          400,
        );
      }
    }
    if (isLinkedMode) {
      const regIds = linkedBeneficiaries.map((b) => b.registrationId);
      const dupes = regIds.filter((r, i) => regIds.indexOf(r) !== i);
      if (dupes.length > 0) {
        throw new AppException(
          ErrorCodes.VALIDATION_ERROR,
          "Duplicate registration IDs in linked beneficiaries",
          400,
        );
      }
    }

    const event = await findEventForBatch(db, eventId);
    if (!event) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }
    assertEventOpen(event);
    assertModuleEnabledForClient(event.client, MODULE);

    const form = await findSponsorFormById(db, formId, eventId);
    if (!form) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Sponsor form not found for this event",
        404,
      );
    }
    const sponsorshipMode =
      ((form.schema as Record<string, unknown> | null)?.sponsorshipSettings as
        | Record<string, unknown>
        | undefined)?.sponsorshipMode ?? "CODE";

    if (isLinkedMode && sponsorshipMode !== "LINKED_ACCOUNT") {
      throw new AppException(
        ErrorCodes.VALIDATION_ERROR,
        "This sponsor form does not accept linked-account sponsorships",
        400,
      );
    }
    if (!isLinkedMode && sponsorshipMode === "LINKED_ACCOUNT") {
      throw new AppException(
        ErrorCodes.VALIDATION_ERROR,
        "This sponsor form requires linked-account sponsorships",
        400,
      );
    }

    const pricing = await getEventPricingForBatch(db, eventId);

    const beneficiaryList = isLinkedMode ? linkedBeneficiaries : beneficiaries;
    const allAccessIds = new Set<string>();
    for (const b of beneficiaryList) {
      for (const id of b.coveredAccessIds) allAccessIds.add(id);
    }

    let accessPriceMap = new Map<string, number>();
    if (allAccessIds.size > 0) {
      const accessItems = await findActiveEventAccess(db, eventId, [
        ...allAccessIds,
      ]);
      const valid = new Set(accessItems.map((a) => a.id));
      const invalid = [...allAccessIds].filter((id) => !valid.has(id));
      if (invalid.length > 0) {
        throw new AppException(
          ErrorCodes.BAD_REQUEST,
          `Invalid access items: ${invalid.join(", ")}`,
          400,
          { invalidAccessIds: invalid },
        );
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
        throw new AppException(
          ErrorCodes.BAD_REQUEST,
          `Time conflicts in covered access items: ${overlapErrors.join("; ")}`,
          400,
          { timeConflicts: overlapErrors },
        );
      }
      accessPriceMap = new Map(accessItems.map((a) => [a.id, a.price]));
    }

    const registrations = new Map<string, RegistrationForBatch>();
    if (isLinkedMode) {
      const registrationIds = linkedBeneficiaries.map((b) => b.registrationId);
      const found = await findRegistrationsForBatch(db, eventId, registrationIds);
      const foundIds = new Set(found.map((r) => r.id));
      const missing = registrationIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new AppException(
          ErrorCodes.NOT_FOUND,
          `Registrations not found: ${missing.join(", ")}`,
          404,
          { missingRegistrationIds: missing },
        );
      }
      for (const r of found) registrations.set(r.id, r);
    }

    return {
      event,
      formId: form.id,
      pricing,
      accessPriceMap,
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
  ): Promise<number> {
    let created = 0;
    // Sequential — unique-code generation must serialize (collision safety).
    for (const b of beneficiaries) {
      const code = await generateUniqueCode((c) => sponsorshipCodeExists(tx, c));
      const totalAmount =
        (b.coversBasePrice ? basePrice : 0) +
        sumAccessPrices(b.coveredAccessIds, accessPriceMap);
      await insertSponsorship(tx, {
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
      created++;
    }
    return created;
  }

  private async createLinkedModeSponsorships(
    tx: DbExecutor,
    eventId: string,
    batchId: string,
    linkedBeneficiaries: NonNullable<
      CreateSponsorshipBatchInput["linkedBeneficiaries"]
    >,
    registrations: Map<string, RegistrationForBatch>,
    autoApprove: boolean,
    accessPriceMap: Map<string, number>,
  ): Promise<number> {
    let created = 0;
    // Sequential — auto-approve mutates the in-memory running total that a later
    // beneficiary targeting the same registration must observe.
    for (const linked of linkedBeneficiaries) {
      const registration = registrations.get(linked.registrationId);
      if (!registration) {
        throw new AppException(
          ErrorCodes.REGISTRATION_NOT_FOUND,
          "Registration not found",
          404,
        );
      }
      const code = await generateUniqueCode((c) => sponsorshipCodeExists(tx, c));
      const beneficiaryName =
        [registration.firstName, registration.lastName]
          .filter(Boolean)
          .join(" ") || registration.email;
      const totalAmount =
        (linked.coversBasePrice ? registration.baseAmount : 0) +
        sumAccessPrices(linked.coveredAccessIds, accessPriceMap);

      if (!autoApprove) {
        await insertSponsorship(tx, {
          batchId,
          eventId,
          code,
          status: "PENDING",
          beneficiaryName,
          beneficiaryEmail: registration.email,
          beneficiaryPhone: registration.phone ?? null,
          beneficiaryAddress: null,
          coversBasePrice: linked.coversBasePrice,
          coveredAccessIds: linked.coveredAccessIds,
          totalAmount,
          targetRegistrationId: linked.registrationId,
        });
        created++;
        continue;
      }

      const sponsorship = await insertSponsorship(tx, {
        batchId,
        eventId,
        code,
        status: "USED",
        beneficiaryName,
        beneficiaryEmail: registration.email,
        beneficiaryPhone: registration.phone ?? null,
        beneficiaryAddress: null,
        coversBasePrice: linked.coversBasePrice,
        coveredAccessIds: linked.coveredAccessIds,
        totalAmount,
      });

      const priceBreakdown =
        registration.priceBreakdown as RegistrationForCalculation["priceBreakdown"];
      const oldCovered =
        registration.paymentStatus === "PARTIAL"
          ? await getAlreadyCoveredAccessIds(tx, linked.registrationId)
          : new Set<string>();
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
      await syncPaidCountDelta(
        tx,
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
      );

      // Mutate running total so a later beneficiary on the same reg sees it.
      registration.sponsorshipAmount = updatedSponsorshipAmount;
      created++;
    }
    return created;
  }

  // ==========================================================================
  // Link / unlink (own txn; *Tx / *Internal variants ride the caller's tx and
  // are exported for the registrations module).
  // ==========================================================================

  linkSponsorshipToRegistration(
    sponsorshipId: string,
    registrationId: string,
    adminUserId: string,
  ): Promise<LinkSponsorshipResult> {
    return this.runTxn((tx) =>
      this.linkSponsorshipToRegistrationTx(
        tx,
        sponsorshipId,
        registrationId,
        adminUserId,
      ),
    );
  }

  async linkSponsorshipToRegistrationTx(
    tx: DbExecutor,
    sponsorshipId: string,
    registrationId: string,
    adminUserId: string,
  ): Promise<LinkSponsorshipResult> {
    const sponsorship = await findSponsorshipForLink(tx, sponsorshipId);
    if (!sponsorship) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Sponsorship not found", 404);
    }
    assertEventWritable(sponsorship.event);
    assertModuleEnabledForClient(sponsorship.event.client, MODULE);

    if (sponsorship.status === "CANCELLED") {
      throw new AppException(
        ErrorCodes.BAD_REQUEST,
        "Cannot link a cancelled sponsorship",
        400,
        { code: "SPONSORSHIP_CANCELLED" },
      );
    }

    const registration = await findRegistrationForLink(tx, registrationId);
    if (!registration) {
      throw new AppException(
        ErrorCodes.REGISTRATION_NOT_FOUND,
        "Registration not found",
        404,
      );
    }
    if (sponsorship.eventId !== registration.eventId) {
      throw new AppException(
        ErrorCodes.BAD_REQUEST,
        "Sponsorship and registration must be for the same event",
        400,
      );
    }

    const existingLink = await findUsage(tx, sponsorshipId, registrationId);
    if (existingLink) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        "Sponsorship is already linked to this registration",
        409,
        { code: "SPONSORSHIP_ALREADY_LINKED" },
      );
    }

    const coverage = {
      coversBasePrice: sponsorship.coversBasePrice,
      coveredAccessIds: sponsorship.coveredAccessIds ?? [],
      totalAmount: sponsorship.totalAmount,
    };
    const warnings = detectCoverageOverlap(registration.existingUsages, coverage);

    const priceBreakdown =
      registration.priceBreakdown as RegistrationForCalculation["priceBreakdown"];
    const applicableAmount = calculateApplicableAmount(coverage, {
      totalAmount: registration.totalAmount,
      baseAmount: registration.baseAmount,
      accessTypeIds: registration.accessTypeIds,
      priceBreakdown,
    });

    if (applicableAmount === 0 && sponsorship.totalAmount > 0) {
      throw new AppException(
        ErrorCodes.SPONSORSHIP_NOT_APPLICABLE,
        "Sponsorship coverage does not apply to this registration (no overlap between sponsored items and registration selections)",
        400,
      );
    }

    const oldCovered = await getAlreadyCoveredAccessIds(tx, registrationId);

    const usage = await insertUsage(tx, {
      sponsorshipId,
      registrationId,
      amountApplied: applicableAmount,
      appliedBy: adminUserId,
    });

    // Atomic CAS: only flips to USED while not CANCELLED.
    const casCount = await casSetSponsorshipUsed(tx, sponsorshipId);
    if (casCount === 0) {
      throw new AppException(
        ErrorCodes.SPONSORSHIP_STATUS_CONFLICT,
        "Sponsorship cannot be linked (may be cancelled or already processing)",
        409,
      );
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

    const newCovered = await getAlreadyCoveredAccessIds(tx, registrationId);
    await syncPaidCountDelta(
      tx,
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
    );

    // ponytail: audit + realtime + SPONSORSHIP_APPLIED email omitted — deferred.

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
  }

  async linkSponsorshipByCode(
    registrationId: string,
    code: string,
    adminUserId: string,
  ): Promise<LinkSponsorshipResult> {
    const registration = await getRegistrationForSponsorship(registrationId);
    if (!registration) {
      throw new AppException(
        ErrorCodes.REGISTRATION_NOT_FOUND,
        "Registration not found",
        404,
      );
    }
    const sponsorship = await getSponsorshipByCode(registration.event.id, code);
    if (!sponsorship) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        `Code ${code} not found for this event`,
        404,
        { code: "SPONSORSHIP_NOT_FOUND" },
      );
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
    performedBy?: string,
  ): Promise<void> {
    return this.runTxn((tx) =>
      this.unlinkSponsorshipFromRegistrationInternal(
        tx,
        sponsorshipId,
        registrationId,
        performedBy,
      ),
    );
  }

  async unlinkSponsorshipFromRegistrationInternal(
    tx: DbExecutor,
    sponsorshipId: string,
    registrationId: string,
    _performedBy?: string,
  ): Promise<void> {
    const usage = await findUsage(tx, sponsorshipId, registrationId);
    if (!usage) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Sponsorship is not linked to this registration",
        404,
      );
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
      ? await getAlreadyCoveredAccessIds(tx, registrationId)
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
      const newCovered = await getAlreadyCoveredAccessIds(tx, registrationId);
      await syncPaidCountDelta(
        tx,
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

  async unlinkSponsorshipFromAllRegistrations(
    tx: DbExecutor,
    sponsorshipId: string,
    usages: Array<{ registrationId: string | null }>,
    performedBy?: string,
  ): Promise<void> {
    // Sequential — each unlink recomputes state the next iteration reads.
    for (const usage of usages) {
      if (!usage.registrationId) continue;
      await this.unlinkSponsorshipFromRegistrationInternal(
        tx,
        sponsorshipId,
        usage.registrationId,
        performedBy,
      );
    }
  }

  // ==========================================================================
  // Recalculation — rides the caller's tx (exported for registrations wave-3).
  // ==========================================================================

  async recalculateUsageAmounts(
    tx: DbExecutor,
    sponsorshipId: string,
  ): Promise<void> {
    const sponsorship = await findSponsorshipForRecalc(tx, sponsorshipId);
    if (!sponsorship) return;

    // Sequential — each iteration re-reads the running total for its registration.
    for (const usage of sponsorship.usages) {
      const registration = usage.registration;
      if (!registration) continue;

      const priceBreakdown =
        registration.priceBreakdown as RegistrationForCalculation["priceBreakdown"];
      const newAmount = calculateApplicableAmount(
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
          : totalSponsorshipAmount >= registration.totalAmount &&
              registration.totalAmount > 0
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
      const updatedPriceBreakdown = {
        ...priceBreakdown,
        sponsorshipTotal: totalSponsorshipAmount,
        total: Math.max(0, subtotal - totalSponsorshipAmount),
      };

      await updateRegistrationSettlement(tx, registration.id, {
        sponsorshipAmount: totalSponsorshipAmount,
        paymentStatus: nextPaymentStatus,
        paidAt: nextPaidAt,
        priceBreakdown: updatedPriceBreakdown,
      });

      if (oldPaymentStatus !== nextPaymentStatus) {
        const oldCovered =
          oldPaymentStatus === "PARTIAL"
            ? await getAlreadyCoveredAccessIds(tx, registration.id, sponsorshipId)
            : new Set<string>();
        const newCovered =
          nextPaymentStatus === "PARTIAL"
            ? await getAlreadyCoveredAccessIds(tx, registration.id)
            : new Set<string>();
        await syncPaidCountDelta(
          tx,
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
        );
      }
    }
  }
}
