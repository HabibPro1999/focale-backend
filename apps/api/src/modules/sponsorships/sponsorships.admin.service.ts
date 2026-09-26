import { Injectable } from "@nestjs/common";
import {
  ErrorCodes,
  type AppEvent,
  type AvailableSponsorship,
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
  changeSponsorshipCoverageTxn,
  deleteSponsorshipRow,
  emitSettlementEvents,
  enqueueSponsorshipEmailOutbox,
  findActiveEventAccess,
  findRegistrationForLink,
  findSponsorshipForLink,
  findSponsorshipForMutation,
  getEventBasePrice,
  getEventPricingForBatch,
  getLinkedSponsorships,
  getPendingSponsorships,
  getRegistrationCoverage,
  getRegistrationForSponsorship,
  getSponsorshipById,
  getSponsorshipByCode,
  insertAuditLog,
  linkSponsorshipToRegistrationTxn,
  listSponsorships,
  lockSponsorshipForUpdate,
  releaseSponsorshipTxn,
  unlinkSponsorshipFromRegistrationTxn,
  updateSponsorshipRow,
  withLockingTxn,
  type DbExecutor,
  type SponsorshipUnlinkResult,
  type SponsorshipWithUsages,
} from "@app/db";
import { buildLinkedSponsorshipContext } from "@app/integrations";
import { assertEventWritable } from "../events";
import { assertModuleEnabledForClient } from "../clients/module-gates";
import { AccessService } from "../access/access.service";
import { AppException } from "../../core/app-exception";
import {
  detectCoverageOverlap,
  validateCoveredAccessTimeOverlap,
  type ExistingUsage,
} from "./sponsorships.utils";
import {
  countsChanged,
  registrationEvents,
  rethrowSponsorshipException,
} from "./sponsorships.settlement";

// Admin side of sponsorships (plan 5.7): the authenticated routes' reads and
// every change to an existing sponsorship (coverage edit, cancel, delete,
// link and unlink by an admin). The anonymous sponsor form uses
// SponsorshipsPublicService instead, which cannot reach any of these.

const MODULE = "sponsorships";

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

@Injectable()
export class SponsorshipsAdminService {
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

  getLinkedSponsorships(registrationId: string) {
    return getLinkedSponsorships(registrationId);
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
        ErrorCodes.CHECKIN_EVENT_MISMATCH,
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
