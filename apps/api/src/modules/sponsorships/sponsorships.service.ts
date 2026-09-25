import { Injectable } from "@nestjs/common";
import {
  ErrorCodes,
  type AppEvent,
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
  normalizeSponsorshipCode,
  type RegistrationForCalculation,
} from "@app/shared";
import {
  SponsorshipSettlementError,
  changeSponsorshipCoverageTxn,
  deleteSponsorshipRow,
  emitSettlementEvents,
  enqueueSponsorshipEmailOutbox,
  enqueueTriggeredEmailOutbox,
  findActiveEventAccess,
  findEventForBatch,
  findRegistrationForLink,
  findRegistrationsForBatch,
  findSponsorFormById,
  findSponsorshipForLink,
  findSponsorshipForMutation,
  getActiveSponsorForm,
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
  insertAuditLog,
  insertSponsorship,
  insertSponsorshipBatch,
  linkSponsorshipToRegistrationTxn,
  listSponsorships,
  lockRegistrationsForUpdate,
  lockSponsorshipForUpdate,
  readSponsorshipTarget,
  releaseSponsorshipTxn,
  searchRegistrantsForSponsorship,
  settlementEventPair,
  sponsorshipCodeExists,
  sponsorshipLinkRefusal,
  unlinkSponsorshipFromRegistrationTxn,
  updateSponsorshipRow,
  withLockingTxn,
  type AccessItemForOverlap,
  type DbExecutor,
  type RegistrationForBatch,
  type SettleRegistrationResult,
  type SponsorshipRow,
  type SponsorshipUnlinkResult,
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
import { AccessService, toAccessAppException } from "../access/access.service";
import { AppException } from "../../core/app-exception";
import {
  detectCoverageOverlap,
  generateUniqueCode,
  validateCoveredAccessTimeOverlap,
  type ExistingUsage,
} from "./sponsorships.utils";

const MODULE = "sponsorships";

/** Who a linked-mode batch's automatic links are recorded as. */
const BATCH_LINK_ACTOR = "SYSTEM";

function sumAccessPrices(
  coveredAccessIds: string[],
  accessPriceMap: Map<string, number>,
): number {
  return coveredAccessIds.reduce(
    (sum, id) => sum + (accessPriceMap.get(id) ?? 0),
    0,
  );
}

/**
 * The sponsorship settlement refusals (@app/db) and access paid-count errors
 * as the API's AppExceptions. Messages and codes of the refusals that
 * existed before plan 2.8 are unchanged.
 */
function toSponsorshipAppException(err: unknown): unknown {
  if (!(err instanceof SponsorshipSettlementError)) return toAccessAppException(err);
  const { details } = err;
  switch (err.reason) {
    case "SPONSORSHIP_NOT_FOUND":
      return new AppException(ErrorCodes.NOT_FOUND, "Sponsorship not found", 404);
    case "SPONSORSHIP_CANCELLED":
      return new AppException(ErrorCodes.BAD_REQUEST, "Cannot link a cancelled sponsorship", 400, {
        code: "SPONSORSHIP_CANCELLED",
      });
    case "REGISTRATION_NOT_FOUND":
      return new AppException(ErrorCodes.REGISTRATION_NOT_FOUND, "Registration not found", 404);
    case "EVENT_MISMATCH":
      return new AppException(
        ErrorCodes.BAD_REQUEST,
        "Sponsorship and registration must be for the same event",
        400,
      );
    case "ALREADY_LINKED":
      return new AppException(ErrorCodes.CONFLICT, "Sponsorship is already linked to this registration", 409, {
        code: "SPONSORSHIP_ALREADY_LINKED",
      });
    case "NOT_LINKED":
      return new AppException(ErrorCodes.NOT_FOUND, "Sponsorship is not linked to this registration", 404);
    case "NOT_APPLICABLE":
      return new AppException(
        ErrorCodes.SPONSORSHIP_NOT_APPLICABLE,
        "Sponsorship coverage does not apply to this registration (no overlap between sponsored items and registration selections)",
        400,
      );
    case "TARGET_SETTLED":
      return new AppException(
        ErrorCodes.SPONSORSHIP_TARGET_SETTLED,
        `The registration is ${details.paymentStatus}: its sponsorship cannot change`,
        409,
        { registrationId: details.registrationId, paymentStatus: details.paymentStatus },
      );
    case "EXCEEDS_AMOUNT_DUE":
      return new AppException(
        ErrorCodes.SPONSORSHIP_EXCEEDS_AMOUNT_DUE,
        "The registration has already paid more than it would owe with this sponsorship",
        409,
        { registrationId: details.registrationId, paidAmount: details.paidAmount, amountDue: details.amountDue },
      );
  }
  return err;
}

function rethrowSponsorshipException(err: unknown): never {
  throw toSponsorshipAppException(err);
}

/** Registration events after a sponsorship change settled it (networking re-sync included). */
function registrationEvents(
  clientId: string,
  registrationId: string,
  settled: SettleRegistrationResult,
): AppEvent[] {
  const moved = [...settled.paidAccess.incremented, ...settled.paidAccess.decremented];
  return settlementEventPair({
    id: registrationId,
    eventId: settled.eventId,
    clientId,
    oldStatus: settled.before.paymentStatus,
    newStatus: settled.after.paymentStatus,
    emitCountsChanged: false,
    accessIds: moved,
  });
}

function countsChanged(clientId: string, eventId: string, settled: SettleRegistrationResult[]): AppEvent {
  const accessIds = new Set<string>();
  for (const result of settled) {
    for (const id of [...result.paidAccess.incremented, ...result.paidAccess.decremented]) accessIds.add(id);
  }
  return {
    type: "eventAccess.countsChanged",
    clientId,
    eventId,
    payload: { id: eventId, accessIds: [...accessIds].sort() },
    ts: Date.now(),
  };
}

/** The Sponsorship UNLINK_FROM_REGISTRATION audit changes of one unlink. */
function unlinkChanges(
  unlinked: SponsorshipUnlinkResult,
  sponsorshipStatus?: { before: string; after: string },
): Record<string, { old: unknown; new: unknown }> {
  const { settled } = unlinked;
  const changes: Record<string, { old: unknown; new: unknown }> = {
    registrationId: { old: unlinked.registrationId, new: null },
    amountApplied: { old: unlinked.usage.amountApplied, new: 0 },
    sponsorshipAmount: { old: settled.before.sponsorshipAmount, new: settled.after.sponsorshipAmount },
  };
  if (settled.before.paymentStatus !== settled.after.paymentStatus) {
    changes.paymentStatus = { old: settled.before.paymentStatus, new: settled.after.paymentStatus };
  }
  if (unlinked.clearedPaymentMethod !== null) {
    changes.paymentMethod = { old: unlinked.clearedPaymentMethod, new: null };
  }
  if (unlinked.clearedSponsorshipCode !== null) {
    changes.sponsorshipCode = { old: unlinked.clearedSponsorshipCode, new: null };
  }
  if (sponsorshipStatus && sponsorshipStatus.before !== sponsorshipStatus.after) {
    changes.status = { old: sponsorshipStatus.before, new: sponsorshipStatus.after };
  }
  return changes;
}

interface BatchContext {
  event: Awaited<ReturnType<typeof findEventForBatch>> & object;
  formId: string;
  pricing: { basePrice: number; currency: string } | null;
  accessPriceMap: Map<string, number>;
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
  // Update / cancel / delete (plan 2.8): lock the sponsorship, re-read it,
  // then its linked registrations in ascending id order, each settled
  // through settleRegistrationTxn.
  // ==========================================================================

  async updateSponsorship(
    id: string,
    input: UpdateSponsorshipInput,
    performedBy?: string,
  ): Promise<SponsorshipWithUsages> {
    if (input.status === "CANCELLED") {
      return this.cancelSponsorship(id, performedBy);
    }
    await withLockingTxn((tx) => this.updateSponsorshipCore(tx, id, input, performedBy));
    return (await getSponsorshipById(id)) as SponsorshipWithUsages;
  }

  /** Lock the sponsorship and re-read it for a mutation (404 and the event/module gates). */
  private async lockSponsorshipForMutation(tx: DbExecutor, id: string) {
    const sponsorship = (await lockSponsorshipForUpdate(tx, id))
      ? await findSponsorshipForMutation(tx, id)
      : null;
    if (!sponsorship) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Sponsorship not found", 404);
    }
    assertEventWritable(sponsorship.event);
    assertModuleEnabledForClient(sponsorship.event.client, MODULE);
    return sponsorship;
  }

  private async updateSponsorshipCore(
    tx: DbExecutor,
    id: string,
    input: UpdateSponsorshipInput,
    performedBy?: string,
  ): Promise<void> {
    const sponsorship = await this.lockSponsorshipForMutation(tx, id);

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
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    const beneficiaryFields = [
      "beneficiaryName",
      "beneficiaryEmail",
      "beneficiaryPhone",
      "beneficiaryAddress",
    ] as const;
    for (const field of beneficiaryFields) {
      const next = input[field];
      if (next === undefined) continue;
      (patch as Record<string, unknown>)[field] = next;
      if (next !== sponsorship[field]) changes[field] = { old: sponsorship[field], new: next };
    }
    if (coverageChanged) {
      if (nextCoversBasePrice !== sponsorship.coversBasePrice) {
        changes.coversBasePrice = { old: sponsorship.coversBasePrice, new: nextCoversBasePrice };
      }
      if (JSON.stringify(nextCoveredAccessIds) !== JSON.stringify(sponsorship.coveredAccessIds)) {
        changes.coveredAccessIds = { old: sponsorship.coveredAccessIds, new: nextCoveredAccessIds };
      }
      if (nextTotalAmount !== sponsorship.totalAmount) {
        changes.totalAmount = { old: sponsorship.totalAmount, new: nextTotalAmount };
      }
    }

    const clientId = sponsorship.event.clientId;
    const pending: AppEvent[] = [];
    if (coverageChanged) {
      // Every linked registration is locked and settled against the new coverage.
      const changed = await changeSponsorshipCoverageTxn(
        tx,
        id,
        {
          coversBasePrice: nextCoversBasePrice,
          coveredAccessIds: nextCoveredAccessIds,
          totalAmount: nextTotalAmount,
        },
        patch,
      ).catch(rethrowSponsorshipException);
      const settled = changed?.settled ?? [];
      for (const result of settled) {
        await this.access.handleCapacityReached(sponsorship.eventId, result.paidAccess.incremented, tx);
        pending.push(...registrationEvents(clientId, result.registrationId, result));
      }
      if (settled.length > 0) pending.push(countsChanged(clientId, sponsorship.eventId, settled));
    } else if (Object.keys(patch).length > 0) {
      await updateSponsorshipRow(tx, id, patch);
    }

    if (Object.keys(changes).length > 0) {
      await insertAuditLog(
        { entityType: "Sponsorship", entityId: id, action: "UPDATE", changes, performedBy: performedBy ?? null },
        tx,
      );
    }
    pending.push({
      type: "sponsorship.updated",
      clientId,
      eventId: sponsorship.eventId,
      payload: { id },
      ts: Date.now(),
    });
    await emitSettlementEvents(tx, pending);
  }

  async cancelSponsorship(
    id: string,
    performedBy?: string,
  ): Promise<SponsorshipWithUsages> {
    await withLockingTxn((tx) => this.releaseSponsorshipCore(tx, id, "cancel", performedBy));
    return (await getSponsorshipById(id)) as SponsorshipWithUsages;
  }

  async deleteSponsorship(id: string, performedBy?: string): Promise<void> {
    await withLockingTxn((tx) => this.releaseSponsorshipCore(tx, id, "delete", performedBy));
  }

  /**
   * Cancel or delete: unlink every linked registration (settled, and never
   * back out of REFUNDED/WAIVED; a PAID registration whose amount would
   * change refuses with 409), then set CANCELLED or delete the row.
   * Cancelling unlinks lingering usages even when already CANCELLED.
   */
  private async releaseSponsorshipCore(
    tx: DbExecutor,
    id: string,
    mode: "cancel" | "delete",
    performedBy?: string,
  ): Promise<void> {
    const sponsorship = await this.lockSponsorshipForMutation(tx, id);
    const released = await releaseSponsorshipTxn(tx, id).catch(rethrowSponsorshipException);
    const unlinked = released?.unlinked ?? [];
    const clientId = sponsorship.event.clientId;
    const eventId = sponsorship.eventId;
    const pending: AppEvent[] = [];

    for (const result of unlinked) {
      await this.access.handleCapacityReached(eventId, result.settled.paidAccess.incremented, tx);
      await insertAuditLog(
        {
          entityType: "Sponsorship",
          entityId: id,
          action: "UNLINK_FROM_REGISTRATION",
          changes: unlinkChanges(result),
          performedBy: performedBy ?? null,
        },
        tx,
      );
      pending.push(...registrationEvents(clientId, result.registrationId, result.settled));
    }

    if (mode === "cancel") {
      if (sponsorship.status !== "CANCELLED") {
        await updateSponsorshipRow(tx, id, { status: "CANCELLED" });
        await insertAuditLog(
          {
            entityType: "Sponsorship",
            entityId: id,
            action: "CANCEL",
            changes: { status: { old: sponsorship.status, new: "CANCELLED" } },
            performedBy: performedBy ?? null,
          },
          tx,
        );
      }
      pending.push({ type: "sponsorship.cancelled", clientId, eventId, payload: { id }, ts: Date.now() });
    } else {
      await insertAuditLog(
        {
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
          performedBy: performedBy ?? null,
        },
        tx,
      );
      await deleteSponsorshipRow(tx, id);
      pending.push({ type: "sponsorship.deleted", clientId, eventId, payload: { id }, ts: Date.now() });
    }
    if (unlinked.length > 0) {
      pending.push(countsChanged(clientId, eventId, unlinked.map((result) => result.settled)));
    }
    await emitSettlementEvents(tx, pending);
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

    return withLockingTxn(async (tx) => {
      const formSchema = (await getFormSchema(tx, context.formId)) as
        | Record<string, unknown>
        | null;
      const sponsorshipSettings = formSchema?.sponsorshipSettings as
        | Record<string, unknown>
        | undefined;
      const autoApprove =
        (sponsorshipSettings?.autoApproveSponsorship as boolean | undefined) ??
        false;

      const batch = await insertSponsorshipBatch(tx, {
        eventId,
        formId: context.formId,
        labName: sponsor.labName,
        contactName: sponsor.contactName,
        email: sponsor.email,
        phone: sponsor.phone ?? null,
        formData: { sponsor, customFields: customFields ?? {} },
      });

      const clientId = context.event.clientId;
      let created: SponsorshipRow[];
      let linkedEmailEntries: LinkedEmailEntry[] = [];
      const pending: AppEvent[] = [];
      if (context.isLinkedMode) {
        const linkedResult = await this.createLinkedModeSponsorships(
          tx,
          eventId,
          batch.id,
          context.linkedBeneficiaries ?? [],
          context.registrations,
          autoApprove,
          context.accessPriceMap,
        );
        created = linkedResult.created;
        linkedEmailEntries = linkedResult.linkedEmailEntries;
        for (const { registrationId, sponsorshipId, settled } of linkedResult.links) {
          pending.push(
            {
              type: "sponsorship.linked",
              clientId,
              eventId,
              payload: { id: sponsorshipId, registrationId },
              ts: Date.now(),
            },
            ...registrationEvents(clientId, registrationId, settled),
          );
        }
        if (linkedResult.links.length > 0) {
          pending.push(countsChanged(clientId, eventId, linkedResult.links.map((link) => link.settled)));
        }
      } else {
        created = await this.createCodeModeSponsorships(
          tx,
          eventId,
          batch.id,
          context.beneficiaries ?? [],
          context.pricing?.basePrice ?? 0,
          context.accessPriceMap,
        );
      }

      await this.queueBatchEmails(
        tx,
        eventId,
        batch.id,
        context,
        {
          labName: sponsor.labName,
          contactName: sponsor.contactName,
          email: sponsor.email,
          phone: sponsor.phone ?? null,
        },
        autoApprove,
        created,
        linkedEmailEntries,
      );

      pending.unshift({
        type: "sponsorship.batchCreated",
        clientId,
        eventId,
        payload: { id: batch.id, batchId: batch.id, count: created.length },
        ts: Date.now(),
      });
      await emitSettlementEvents(tx, pending);
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
    let batchAccessItems: AccessItemForOverlap[] = [];
    if (allAccessIds.size > 0) {
      const accessItems = await findActiveEventAccess(db, eventId, [
        ...allAccessIds,
      ]);
      batchAccessItems = accessItems;
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

  /**
   * Linked-mode beneficiaries: one sponsorship per target registration.
   * Without auto-approve each is created PENDING and targeted at its
   * registration. With auto-approve every target registration is locked
   * first, in ascending id order, and each sponsorship is linked through
   * linkSponsorshipToRegistrationTxn (usage, USED, settlement), unless the
   * link is refused on the locked row (the registration is settled, already
   * paid more than it would owe, or the coverage applies nothing): that
   * sponsorship stays PENDING and targeted, for an admin to review.
   *
   * The new sponsorship rows are created after the registration locks. That
   * does not break the sponsorship → registration lock order: no other
   * transaction can see, let alone lock, a row this one has just inserted.
   */
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
  ): Promise<{
    created: SponsorshipRow[];
    linkedEmailEntries: LinkedEmailEntry[];
    links: Array<{ registrationId: string; sponsorshipId: string; settled: SettleRegistrationResult }>;
  }> {
    const created: SponsorshipRow[] = [];
    const linkedEmailEntries: LinkedEmailEntry[] = [];
    const links: Array<{ registrationId: string; sponsorshipId: string; settled: SettleRegistrationResult }> = [];
    if (autoApprove) {
      await lockRegistrationsForUpdate(
        tx,
        linkedBeneficiaries.map((linked) => linked.registrationId),
      );
    }
    for (const linked of linkedBeneficiaries) {
      const registration = registrations.get(linked.registrationId);
      const target = registration
        ? await readSponsorshipTarget(tx, linked.registrationId)
        : null;
      if (!registration || !target) {
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
      const coverage = {
        coversBasePrice: linked.coversBasePrice,
        coveredAccessIds: linked.coveredAccessIds,
        totalAmount:
          (linked.coversBasePrice ? target.baseAmount : 0) +
          sumAccessPrices(linked.coveredAccessIds, accessPriceMap),
      };
      const refusal = autoApprove ? await sponsorshipLinkRefusal(tx, coverage, target) : null;
      const sponsorship = await insertSponsorship(tx, {
        batchId,
        eventId,
        code,
        status: "PENDING",
        beneficiaryName,
        beneficiaryEmail: registration.email,
        beneficiaryPhone: registration.phone ?? null,
        beneficiaryAddress: null,
        ...coverage,
        ...(autoApprove && !refusal ? {} : { targetRegistrationId: linked.registrationId }),
      });
      if (!autoApprove || refusal) {
        created.push(sponsorship);
        continue;
      }

      const link = await linkSponsorshipToRegistrationTxn(tx, {
        sponsorshipId: sponsorship.id,
        registrationId: linked.registrationId,
        appliedBy: BATCH_LINK_ACTOR,
        fields: { paymentMethod: "LAB_SPONSORSHIP" },
      }).catch(rethrowSponsorshipException);
      const { settled } = link;
      await this.access.handleCapacityReached(eventId, settled.paidAccess.incremented, tx);
      await insertAuditLog(
        {
          entityType: "Sponsorship",
          entityId: sponsorship.id,
          action: "LINK_TO_REGISTRATION",
          changes: {
            registrationId: { old: null, new: linked.registrationId },
            amountApplied: { old: 0, new: link.usage.amountApplied },
            sponsorshipAmount: { old: settled.before.sponsorshipAmount, new: settled.after.sponsorshipAmount },
            status: { old: "PENDING", new: "USED" },
          },
          performedBy: BATCH_LINK_ACTOR,
        },
        tx,
      );

      created.push({ ...sponsorship, status: "USED" });
      links.push({ registrationId: linked.registrationId, sponsorshipId: sponsorship.id, settled });
      linkedEmailEntries.push({
        amountApplied: link.usage.amountApplied,
        isFullySponsored: settled.after.paymentStatus === "SPONSORED",
        sponsorship: {
          code: sponsorship.code,
          beneficiaryName: sponsorship.beneficiaryName,
          coversBasePrice: sponsorship.coversBasePrice,
          coveredAccessIds: sponsorship.coveredAccessIds ?? [],
          totalAmount: sponsorship.totalAmount,
        },
        registration: {
          ...registration,
          totalAmount: settled.after.totalAmount,
          sponsorshipAmount: settled.after.sponsorshipAmount,
          paymentStatus: settled.after.paymentStatus,
          priceBreakdown: settled.after.priceBreakdown,
        },
      });
    }
    return { created, linkedEmailEntries, links };
  }

  /**
   * Batch confirmation to the lab + (auto-approved linked mode) per-beneficiary
   * SPONSORSHIP_LINKED / PAYMENT_CONFIRMED / SPONSORSHIP_PARTIAL emails, all
   * enqueued on the batch transaction (legacy queueBatchEmails parity).
   */
  private async queueBatchEmails(
    tx: DbExecutor,
    eventId: string,
    batchId: string,
    context: BatchContext,
    batch: {
      labName: string;
      contactName: string;
      email: string;
      phone: string | null;
    },
    autoApprove: boolean,
    sponsorships: SponsorshipRow[],
    linkedEmailEntries: LinkedEmailEntry[],
  ): Promise<void> {
    const currency = context.pricing?.currency ?? "TND";
    const eventForEmail = {
      name: context.event.name,
      slug: context.event.slug,
      startDate: context.event.startDate,
      location: context.event.location,
      client: { name: context.event.client.name },
    };

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

      await enqueueSponsorshipEmailOutbox(
        tx,
        {
          trigger: "SPONSORSHIP_LINKED",
          eventId,
          input: {
            recipientEmail: entry.registration.email,
            recipientName:
              entry.registration.firstName || entry.sponsorship.beneficiaryName,
            context: linkedContext as Record<string, unknown>,
            registrationId: entry.registration.id,
          },
        },
        `email:sponsorship:SPONSORSHIP_LINKED:${entry.registration.id}:${entry.sponsorship.code}`,
      );

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
        await enqueueSponsorshipEmailOutbox(
          tx,
          {
            trigger: "SPONSORSHIP_PARTIAL",
            eventId,
            input: {
              recipientEmail: entry.registration.email,
              recipientName:
                entry.registration.firstName ||
                entry.sponsorship.beneficiaryName,
              context: linkedContext as Record<string, unknown>,
              registrationId: entry.registration.id,
            },
          },
          `email:sponsorship:SPONSORSHIP_PARTIAL:${entry.registration.id}:${entry.sponsorship.code}`,
        );
      }
    }
  }

  // ==========================================================================
  // Link / unlink (plan 2.8): lock the sponsorship, then the registration,
  // then settle it through settleRegistrationTxn.
  // ==========================================================================

  linkSponsorshipToRegistration(
    sponsorshipId: string,
    registrationId: string,
    adminUserId: string,
  ): Promise<LinkSponsorshipResult> {
    return withLockingTxn((tx) =>
      this.linkSponsorshipToRegistrationCore(tx, sponsorshipId, registrationId, adminUserId),
    );
  }

  private async linkSponsorshipToRegistrationCore(
    tx: DbExecutor,
    sponsorshipId: string,
    registrationId: string,
    adminUserId: string,
  ): Promise<LinkSponsorshipResult> {
    const sponsorship = (await lockSponsorshipForUpdate(tx, sponsorshipId))
      ? await findSponsorshipForLink(tx, sponsorshipId)
      : null;
    if (!sponsorship) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Sponsorship not found", 404);
    }
    assertEventWritable(sponsorship.event);
    assertModuleEnabledForClient(sponsorship.event.client, MODULE);

    const { usage, settled } = await linkSponsorshipToRegistrationTxn(tx, {
      sponsorshipId,
      registrationId,
      appliedBy: adminUserId,
      fields: { paymentMethod: "LAB_SPONSORSHIP" },
    }).catch(rethrowSponsorshipException);
    await this.access.handleCapacityReached(sponsorship.eventId, settled.paidAccess.incremented, tx);

    const registration = await findRegistrationForLink(tx, registrationId);
    if (!registration) {
      throw new AppException(ErrorCodes.REGISTRATION_NOT_FOUND, "Registration not found", 404);
    }
    const coverage = {
      coversBasePrice: sponsorship.coversBasePrice,
      coveredAccessIds: sponsorship.coveredAccessIds ?? [],
      totalAmount: sponsorship.totalAmount,
    };
    const warnings = detectCoverageOverlap(
      registration.existingUsages.filter((existing) => existing.sponsorshipId !== sponsorshipId),
      coverage,
    );

    const changes: Record<string, { old: unknown; new: unknown }> = {
      registrationId: { old: null, new: registrationId },
      amountApplied: { old: 0, new: usage.amountApplied },
      sponsorshipAmount: { old: settled.before.sponsorshipAmount, new: settled.after.sponsorshipAmount },
    };
    if (sponsorship.status !== "USED") {
      changes.status = { old: sponsorship.status, new: "USED" };
    }
    if (settled.before.paymentStatus !== settled.after.paymentStatus) {
      changes.paymentStatus = { old: settled.before.paymentStatus, new: settled.after.paymentStatus };
    }
    await insertAuditLog(
      {
        entityType: "Sponsorship",
        entityId: sponsorshipId,
        action: "LINK_TO_REGISTRATION",
        changes,
        performedBy: adminUserId,
      },
      tx,
    );

    const clientId = sponsorship.event.clientId;
    await emitSettlementEvents(tx, [
      {
        type: "sponsorship.linked",
        clientId,
        eventId: sponsorship.eventId,
        payload: { id: sponsorshipId, registrationId },
        ts: Date.now(),
      },
      ...registrationEvents(clientId, registrationId, settled),
      countsChanged(clientId, sponsorship.eventId, [settled]),
    ]);

    // SPONSORSHIP_APPLIED email — enqueued on the same txn (legacy parity).
    const [pricing, accessItems] = await Promise.all([
      getEventPricingForBatch(tx, sponsorship.eventId),
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
      registration: {
        id: registration.id,
        email: registration.email,
        firstName: registration.firstName,
        lastName: registration.lastName,
        phone: registration.phone,
        totalAmount: registration.totalAmount,
        baseAmount: registration.baseAmount,
        sponsorshipAmount: registration.sponsorshipAmount,
        linkBaseUrl: registration.linkBaseUrl,
        editToken: registration.editToken,
      },
      event: {
        name: sponsorship.event.name,
        slug: sponsorship.event.slug,
        startDate: sponsorship.event.startDate,
        location: sponsorship.event.location,
        client: { name: sponsorship.event.client.name },
      },
      pricing: pricing ? { basePrice: pricing.basePrice } : null,
      accessItems,
      currency,
    });
    await enqueueSponsorshipEmailOutbox(
      tx,
      {
        trigger: "SPONSORSHIP_APPLIED",
        eventId: sponsorship.eventId,
        input: {
          recipientEmail: registration.email,
          recipientName: registration.firstName || sponsorship.beneficiaryName,
          context: emailContext as Record<string, unknown>,
          registrationId: registration.id,
        },
      },
      `email:sponsorship:SPONSORSHIP_APPLIED:${registration.id}:${sponsorshipId}`,
    );

    return {
      usage: {
        id: usage.id,
        sponsorshipId: usage.sponsorshipId,
        amountApplied: usage.amountApplied,
      },
      registration: {
        totalAmount: settled.after.totalAmount,
        sponsorshipAmount: settled.after.sponsorshipAmount,
        amountDue: calculateSettlement({
          totalAmount: settled.after.totalAmount,
          paidAmount: settled.after.paidAmount,
          sponsorshipAmount: settled.after.sponsorshipAmount,
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
    const normalized = normalizeSponsorshipCode(code);
    const sponsorship = normalized
      ? await getSponsorshipByCode(registration.event.id, normalized)
      : null;
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

  /**
   * Unlink a sponsorship from a registration: the registration is settled
   * without it (status derived; a PAID registration whose amount would
   * change refuses with 409), its signup code is cleared when it was this
   * sponsorship's code, and the sponsorship goes back to PENDING when no
   * usage remains (CANCELLED stays CANCELLED).
   */
  unlinkSponsorshipFromRegistration(
    sponsorshipId: string,
    registrationId: string,
    performedBy?: string,
  ): Promise<void> {
    return withLockingTxn(async (tx) => {
      const sponsorship = (await lockSponsorshipForUpdate(tx, sponsorshipId))
        ? await findSponsorshipForMutation(tx, sponsorshipId)
        : null;
      if (!sponsorship) {
        throw new AppException(ErrorCodes.NOT_FOUND, "Sponsorship is not linked to this registration", 404);
      }
      assertEventWritable(sponsorship.event);
      assertModuleEnabledForClient(sponsorship.event.client, MODULE);
      const unlinked = await unlinkSponsorshipFromRegistrationTxn(tx, {
        sponsorshipId,
        registrationId,
      }).catch(rethrowSponsorshipException);
      const { settled } = unlinked;
      await this.access.handleCapacityReached(settled.eventId, settled.paidAccess.incremented, tx);
      await insertAuditLog(
        {
          entityType: "Sponsorship",
          entityId: sponsorshipId,
          action: "UNLINK_FROM_REGISTRATION",
          changes: unlinkChanges(unlinked, unlinked.status),
          performedBy: performedBy ?? null,
        },
        tx,
      );
      const clientId = sponsorship.event.clientId;
      await emitSettlementEvents(tx, [
        {
          type: "sponsorship.unlinked",
          clientId,
          eventId: settled.eventId,
          payload: { id: sponsorshipId, registrationId },
          ts: Date.now(),
        },
        ...registrationEvents(clientId, registrationId, settled),
        countsChanged(clientId, settled.eventId, [settled]),
      ]);
    });
  }
}
