import {
  ErrorCodes,
  type LinkSponsorshipResult,
} from "@app/contracts";
import {
  calculateSettlement,
  withSponsorshipTotal,
  type RegistrationForCalculation,
} from "@app/shared";
import {
  casSetSponsorshipUsed,
  countUsagesForSponsorship,
  deleteUsage,
  findRegistrationForLink,
  findRegistrationSettlementState,
  findSponsorshipForLink,
  findSponsorshipForRecalc,
  findSponsorshipUnlinkState,
  findUsage,
  findUsageAmountsByRegistration,
  getRegistrationForSponsorship,
  getSponsorshipByCode,
  insertUsage,
  lockRegistrationForUpdate,
  lockRegistrationsForUpdate,
  lockSponsorshipForUpdate,
  updateRegistrationSettlement,
  updateSponsorshipRow,
  updateUsageAmount,
  withLockingTxn,
  type DbExecutor,
} from "@app/db";
import { assertEventWritable } from "../events";
import { assertModuleEnabledForClient } from "../clients/module-gates";
import { AccessService } from "../access/access.service";
import {
  notFound,
  badRequest,
  conflict,
} from "../../core/app-exception";
import {
  applicableAmountFor,
  calculateTotalSponsorshipAmount,
  detectCoverageOverlap,
  determineSponsorshipStatus,
} from "./sponsorships.utils";
import { nextStatusOnApply, statusAfterUnlink, statusAfterRecalc } from "./sponsorship-settlement";
import { queueAppliedSponsorshipEmail } from "./sponsorship-emails";

const MODULE = "sponsorships";

/** Settlement writes share the caller's transaction and preserve sequential lock order. */
export class SponsorshipLinks {
  constructor(private readonly access: AccessService) {}

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

      await queueAppliedSponsorshipEmail(tx, {
        sponsorship, registration, usage, newSponsorshipAmount, sponsorshipId,
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

    const nextStatus = statusAfterUnlink(currentStatus, newSponsorshipAmount, totalAmount, paidAmount);

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

  async unlinkSponsorshipFromAllRegistrations(
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

  async recalculateUsageAmounts(
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
      const { nextPaymentStatus, nextPaidAt } = statusAfterRecalc(registration, totalSponsorshipAmount, settlement);
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
