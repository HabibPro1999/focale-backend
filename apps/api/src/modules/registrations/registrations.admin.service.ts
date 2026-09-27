import {
  ErrorCodes,
  UserRole,
  type AdminEditRegistrationInput,
  type AppEvent,
  type PriceBreakdown,
  type UpdatePaymentInput,
  type UpdateRegistrationInput,
} from "@app/contracts";
import {
  countUsagesForSponsorship,
  deleteRegistrationRow,
  deleteRegistrationUsages,
  enqueueTriggeredEmailOutbox,
  findRegistrationFormSchema,
  findRegistrationUsageLinks,
  getNetworkingProfilePhotoByRegistration,
  insertAuditLog,
  registrationExistsByEmailForm,
  updateRegistrationRow,
  updateSponsorshipRow,
  withTxn,
  type RegistrationPatch,
} from "@app/db";
import { calculateSettlement, isFullySettled } from "@app/shared";
import { Injectable } from "@nestjs/common";
import { AppException, badRequest } from "../../core/app-exception";
import { AccessService } from "../access/access.service";
import { assertModuleEnabledForClient } from "../clients/module-gates";
import { deleteNetworkingPhoto } from "../networking/networking.uploads.service";
import { prepareFormDataForPricing } from "../pricing/form-data-for-pricing";
import { PricingService } from "../pricing/pricing.service";
import { validatePaymentTransition } from "./payment-transitions";
import { breakdownColumns } from "./registrations.enrichment";
import {
  assertRegistrationWritable,
  normalizeEmail,
  registrationAlreadyExists,
  requireRegistrationForMutation,
} from "./registrations.guards";
import { RegistrationsReadService, type AdminRegistration } from "./registrations.read.service";
import { recalculateLinkedSponsorshipSettlement, syncPaidCount } from "./registrations.settlement";
import {
  audit,
  decrementEventRegistered,
  emitRegistrationEventsAndSyncNetworking,
  settlementEventPair,
} from "./registrations.side-effects";

@Injectable()
export class RegistrationsAdminService {
  constructor(
    private readonly access: AccessService,
    private readonly pricing: PricingService,
    private readonly read: RegistrationsReadService,
  ) {}

  // ==========================================================================
  // Admin partial update (payment/note/role)
  // ==========================================================================

  async updateRegistration(
    id: string,
    input: UpdateRegistrationInput,
    performedBy?: string,
  ): Promise<AdminRegistration> {
    await withTxn(async (tx) => {
      const registration = await requireRegistrationForMutation(id, tx);
      assertRegistrationWritable(registration);

      const patch: RegistrationPatch = {};
      if (input.paymentStatus !== undefined) {
        validatePaymentTransition(registration.paymentStatus, input.paymentStatus);
        patch.paymentStatus = input.paymentStatus;
        if (
          isFullySettled(input.paymentStatus) &&
          !registration.paidAt
        ) {
          patch.paidAt = new Date();
        }
      }
      const paidAmount =
        input.paidAmount ??
        (input.paymentStatus === "PAID"
          ? calculateSettlement(registration).netAmount
          : undefined);
      if (paidAmount !== undefined) {
        if (paidAmount > calculateSettlement(registration).netAmount) {
          throw badRequest("Paid amount cannot exceed registration total", { code: ErrorCodes.BAD_REQUEST });
        }
        patch.paidAmount = paidAmount;
      }
      if (input.paymentMethod !== undefined) patch.paymentMethod = input.paymentMethod;
      if (input.paymentReference !== undefined)
        patch.paymentReference = input.paymentReference;
      if (input.paymentProofUrl !== undefined)
        patch.paymentProofUrl = input.paymentProofUrl;
      if (input.note !== undefined) patch.note = input.note;
      if (input.role !== undefined) patch.role = input.role;

      const changes: Record<string, { old: unknown; new: unknown }> = {};
      if (input.note !== undefined && input.note !== registration.note) {
        changes.note = { old: registration.note, new: input.note };
      }
      const statusChanged =
        input.paymentStatus !== undefined &&
        input.paymentStatus !== registration.paymentStatus;
      if (statusChanged) {
        changes.paymentStatus = {
          old: registration.paymentStatus,
          new: input.paymentStatus,
        };
      }
      if (
        patch.paidAmount !== undefined &&
        patch.paidAmount !== registration.paidAmount
      ) {
        changes.paidAmount = {
          old: registration.paidAmount,
          new: patch.paidAmount,
        };
      }
      if (
        input.paymentMethod !== undefined &&
        input.paymentMethod !== registration.paymentMethod
      ) {
        changes.paymentMethod = {
          old: registration.paymentMethod,
          new: input.paymentMethod,
        };
      }
      if (input.role !== undefined && input.role !== registration.role) {
        changes.role = { old: registration.role, new: input.role };
      }

      await updateRegistrationRow(id, patch, tx);

      if (statusChanged) {
        await syncPaidCount(this.access, 
          tx,
          registration,
          registration.paymentStatus,
          input.paymentStatus as string,
        );
      }

      if (Object.keys(changes).length > 0) {
        await audit(tx, {
          entityId: id,
          action: "UPDATE",
          changes,
          performedBy,
        });
      }

      const pending = settlementEventPair({
        id,
        eventId: registration.eventId,
        clientId: registration.event.clientId,
        oldStatus: registration.paymentStatus,
        newStatus: input.paymentStatus,
        emitCountsChanged: statusChanged,
      });
      await emitRegistrationEventsAndSyncNetworking(tx, pending);
    });

    return this.read.getStrippedById(id);
  }

  // ==========================================================================
  // Admin full edit (override — no payment-transition validation)
  // ==========================================================================

  async adminEditRegistration(
    eventId: string,
    id: string,
    input: AdminEditRegistrationInput,
    adminUserId: string,
  ): Promise<AdminRegistration> {
    await withTxn(async (tx) => {
      const registration = await requireRegistrationForMutation(id, tx);
      if (registration.eventId !== eventId) {
        throw badRequest("Registration does not belong to this event", { code: ErrorCodes.BAD_REQUEST });
      }
      assertRegistrationWritable(registration);

      const patch: RegistrationPatch = {};
      const changes: Record<string, { old: unknown; new: unknown }> = {};
      const hasPriceEdits =
        input.accessSelections !== undefined || input.formData !== undefined;
      const setDefaultPaidAmount = (paidAmount: number) => {
        patch.paidAmount = paidAmount;
        if (paidAmount !== registration.paidAmount) {
          changes.paidAmount = {
            old: registration.paidAmount,
            new: paidAmount,
          };
        }
      };

      const inputEmail =
        input.email !== undefined ? normalizeEmail(input.email) : undefined;
      if (inputEmail !== undefined && inputEmail !== registration.email) {
        if (await registrationExistsByEmailForm(inputEmail, registration.formId, tx, id)) {
          throw registrationAlreadyExists();
        }
        patch.email = inputEmail;
        changes.email = { old: registration.email, new: inputEmail };
      }
      if (input.firstName !== undefined && input.firstName !== registration.firstName) {
        patch.firstName = input.firstName;
        changes.firstName = { old: registration.firstName, new: input.firstName };
      }
      if (input.lastName !== undefined && input.lastName !== registration.lastName) {
        patch.lastName = input.lastName;
        changes.lastName = { old: registration.lastName, new: input.lastName };
      }
      if (input.phone !== undefined && input.phone !== registration.phone) {
        patch.phone = input.phone;
        changes.phone = { old: registration.phone, new: input.phone };
      }
      // Admin answers: visible fields only, type-checked, required not
      // enforced; stored and priced as returned.
      const editedFormData =
        input.formData !== undefined
          ? prepareFormDataForPricing(
              (await findRegistrationFormSchema(eventId, tx))?.schema,
              input.formData,
              { enforceRequired: false },
            )
          : undefined;
      if (editedFormData !== undefined) {
        patch.formData = editedFormData;
        changes.formData = { old: "(previous)", new: "(updated)" };
      }
      if (input.role !== undefined && input.role !== registration.role) {
        patch.role = input.role;
        changes.role = { old: registration.role, new: input.role };
      }
      if (input.note !== undefined && input.note !== registration.note) {
        patch.note = input.note;
        changes.note = { old: registration.note, new: input.note };
      }

      // Payment fields — NO transition validation (admin override).
      if (
        input.paymentStatus !== undefined &&
        input.paymentStatus !== registration.paymentStatus
      ) {
        patch.paymentStatus = input.paymentStatus;
        changes.paymentStatus = {
          old: registration.paymentStatus,
          new: input.paymentStatus,
        };
        if (
          isFullySettled(input.paymentStatus) &&
          !registration.paidAt
        ) {
          patch.paidAt = new Date();
        }
      }
      if (
        input.paidAmount !== undefined &&
        input.paidAmount !== registration.paidAmount
      ) {
        if (input.paidAmount > calculateSettlement(registration).netAmount) {
          throw badRequest("Paid amount cannot exceed registration total", { code: ErrorCodes.BAD_REQUEST });
        }
        patch.paidAmount = input.paidAmount;
        changes.paidAmount = { old: registration.paidAmount, new: input.paidAmount };
      }
      if (
        input.paymentMethod !== undefined &&
        input.paymentMethod !== registration.paymentMethod
      ) {
        patch.paymentMethod = input.paymentMethod;
        changes.paymentMethod = {
          old: registration.paymentMethod,
          new: input.paymentMethod,
        };
      }
      if (input.paymentReference !== undefined)
        patch.paymentReference = input.paymentReference;
      if (input.paymentProofUrl !== undefined)
        patch.paymentProofUrl = input.paymentProofUrl;
      if (input.labName !== undefined) patch.labName = input.labName;

      // Price-affecting edit branch.
      if (hasPriceEdits) {
        assertModuleEnabledForClient(
          registration.event.client,
          "pricing",
        );
        const effectiveFormData =
          editedFormData ??
          (registration.formData as Record<string, unknown>) ??
          {};
        const oldBreakdown = registration.priceBreakdown as PriceBreakdown | null;
        const oldAccessItems = (oldBreakdown?.accessItems ?? []).map((item) => ({
          accessId: item.accessId,
          quantity: item.quantity,
        }));
        const effectiveAccessSelections = input.accessSelections ?? oldAccessItems;
        const selectedAccessItems = effectiveAccessSelections.map((s) => ({
          accessId: s.accessId,
          quantity: s.quantity,
        }));
        const existingAccessIds = new Set(registration.accessTypeIds ?? []);

        if (
          input.accessSelections !== undefined &&
          effectiveAccessSelections.length > 0
        ) {
          await this.access.assertAccessSelectionsValid(
            eventId,
            effectiveAccessSelections,
            effectiveFormData,
            existingAccessIds,
            tx,
          );
        }

        const existingSponsorshipCodes = registration.sponsorshipCode
          ? [registration.sponsorshipCode]
          : [];
        let priceBreakdown = await this.pricing.calculatePrice(
          eventId,
          {
            formData: effectiveFormData,
            selectedAccessItems,
            sponsorshipCodes: existingSponsorshipCodes,
          },
          tx,
        );

        const oldAccessTypeIds = registration.accessTypeIds ?? [];
        if (input.accessSelections !== undefined) {
          await Promise.all(
            oldAccessItems.map((old) =>
              this.access.decrementAccessRegisteredCountTx(
                old.accessId,
                old.quantity,
                tx,
              ),
            ),
          );
          await Promise.all(
            effectiveAccessSelections
              .filter((sel) => sel.quantity > 0)
              .map((sel) =>
                this.access.incrementAccessRegisteredCountTx(
                  sel.accessId,
                  sel.quantity,
                  tx,
                ),
              ),
          );
        }

        const settlement = await recalculateLinkedSponsorshipSettlement(
          tx,
          { ...registration, paidAmount: input.paidAmount ?? registration.paidAmount },
          priceBreakdown,
        );
        priceBreakdown = settlement.priceBreakdown;

        const nextPaymentStatus =
          input.paymentStatus ??
          settlement.paymentStatus ??
          registration.paymentStatus;
        const shouldDefaultPaidAmount =
          input.paymentStatus === "PAID" && input.paidAmount === undefined;
        const defaultPaidAmount = shouldDefaultPaidAmount
          ? calculateSettlement({
              totalAmount: priceBreakdown.subtotal,
              paidAmount: registration.paidAmount,
              sponsorshipAmount: settlement.sponsorshipAmount,
            }).netAmount
          : undefined;
        const nextPaidAmount =
          input.paidAmount ?? defaultPaidAmount ?? registration.paidAmount;
        if (nextPaidAmount > priceBreakdown.total) {
          throw badRequest("Paid amount cannot exceed registration total", { code: ErrorCodes.BAD_REQUEST });
        }

        patch.totalAmount = priceBreakdown.subtotal;
        Object.assign(patch, breakdownColumns(priceBreakdown));
        patch.sponsorshipAmount = settlement.sponsorshipAmount;
        patch.accessTypeIds = effectiveAccessSelections.map((s) => s.accessId);
        if (shouldDefaultPaidAmount) {
          setDefaultPaidAmount(nextPaidAmount);
        }
        if (
          input.paymentStatus === undefined &&
          settlement.paymentStatus !== undefined &&
          settlement.paymentStatus !== registration.paymentStatus
        ) {
          patch.paymentStatus = settlement.paymentStatus;
          changes.paymentStatus = {
            old: registration.paymentStatus,
            new: settlement.paymentStatus,
          };
        }
        if (input.paymentStatus === undefined && settlement.paidAt !== undefined) {
          patch.paidAt = settlement.paidAt;
        }
        if (input.accessSelections !== undefined) {
          changes.accessSelections = {
            old: oldAccessTypeIds,
            new: effectiveAccessSelections.map((s) => s.accessId),
          };
        }
        changes.totalAmount = {
          old: registration.totalAmount,
          new: priceBreakdown.subtotal,
        };

        if (
          input.accessSelections !== undefined ||
          nextPaymentStatus !== registration.paymentStatus
        ) {
          await this.access.syncPaidCountDelta(
            eventId,
            {
              status: registration.paymentStatus,
              priceBreakdown: registration.priceBreakdown,
              coveredAccessIds: settlement.coveredAccessIds,
            },
            {
              status: nextPaymentStatus,
              priceBreakdown,
              coveredAccessIds: settlement.coveredAccessIds,
            },
            tx,
          );
        }
      }

      if (
        !hasPriceEdits &&
        input.paymentStatus === "PAID" &&
        input.paidAmount === undefined
      ) {
        setDefaultPaidAmount(calculateSettlement(registration).netAmount);
      }

      patch.lastEditedAt = new Date();
      await updateRegistrationRow(id, patch, tx);

      // paidCount sync for the payment-status-only path (no access/formData edit).
      if (
        input.paymentStatus !== undefined &&
        input.paymentStatus !== registration.paymentStatus &&
        !hasPriceEdits
      ) {
        await syncPaidCount(this.access, 
          tx,
          { id, eventId, priceBreakdown: registration.priceBreakdown },
          registration.paymentStatus,
          input.paymentStatus,
        );
      }

      if (Object.keys(changes).length > 0) {
        await audit(tx, {
          entityId: id,
          action: "UPDATE",
          changes,
          performedBy: adminUserId,
        });
      }

      const statusChanged =
        input.paymentStatus !== undefined &&
        input.paymentStatus !== registration.paymentStatus;
      const pending = settlementEventPair({
        id,
        eventId,
        clientId: registration.event.clientId,
        oldStatus: registration.paymentStatus,
        newStatus:
          patch.paymentStatus ?? input.paymentStatus,
        emitCountsChanged: !!(
          statusChanged ||
          (input.accessSelections && input.accessSelections.length > 0)
        ),
      });
      await emitRegistrationEventsAndSyncNetworking(tx, pending);
    });

    return this.read.getStrippedById(id);
  }

  // ==========================================================================
  // Delete
  // ==========================================================================

  async deleteRegistration(
    id: string,
    performedBy?: string,
    force?: boolean,
    requestingUserRole?: number,
  ): Promise<void> {
    if (
      force &&
      requestingUserRole !== UserRole.CLIENT_ADMIN &&
      requestingUserRole !== UserRole.SUPER_ADMIN
    ) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        "Only admins can force-delete registrations",
        403,
      );
    }

    const networkingPhoto = await withTxn(async (tx) => {
      const registration = await requireRegistrationForMutation(id, tx);
      assertRegistrationWritable(registration);

      if (registration.paymentStatus === "PAID" && !force) {
        throw badRequest("Cannot delete a paid registration. Use refund instead.", { code: ErrorCodes.REGISTRATION_DELETE_BLOCKED });
      }

      await audit(tx, {
        entityId: id,
        action: "DELETE",
        changes: {
          email: { old: registration.email, new: null },
          firstName: { old: registration.firstName, new: null },
          lastName: { old: registration.lastName, new: null },
          paymentStatus: { old: registration.paymentStatus, new: null },
          ...(force ? { forceDelete: { old: null, new: true } } : {}),
        },
        performedBy,
      });

      const usages = await findRegistrationUsageLinks(id, tx);
      const coveredAccessIds =
        registration.paymentStatus === "PARTIAL"
          ? await this.access.getAlreadyCoveredAccessIds(id, tx)
          : new Set<string>();

      if (usages.length > 0) {
        await deleteRegistrationUsages(id, tx);
        const sponsorshipIds = [...new Set(usages.map((u) => u.sponsorshipId))];
        for (const sponsorshipId of sponsorshipIds) {
          const remaining = await countUsagesForSponsorship(tx, sponsorshipId);
          await updateSponsorshipRow(tx, sponsorshipId, {
            status: remaining > 0 ? "USED" : "PENDING",
          });
        }
      }

      const priceBreakdown = registration.priceBreakdown as PriceBreakdown;
      if (priceBreakdown.accessItems) {
        await Promise.all(
          priceBreakdown.accessItems.map((item) =>
            this.access.decrementAccessRegisteredCountTx(item.accessId, item.quantity, tx),
          ),
        );
      }

      await this.access.syncPaidCountDelta(
        registration.eventId,
        { status: registration.paymentStatus, priceBreakdown, coveredAccessIds },
        { status: "PENDING", priceBreakdown },
        tx,
      );

      await decrementEventRegistered(tx, registration.eventId);
      // The networking profile cascades with the row; keep its photo for cleanup after commit.
      const photo = await getNetworkingProfilePhotoByRegistration(id, tx);
      await deleteRegistrationRow(id, tx);

      const clientId = registration.event.clientId;
      const accessIds = priceBreakdown.accessItems?.map((a) => a.accessId) ?? [];
      const pending: AppEvent[] = [
        {
          type: "registration.deleted",
          clientId,
          eventId: registration.eventId,
          payload: { id: registration.id, email: registration.email },
          ts: Date.now(),
        },
        {
          type: "eventAccess.countsChanged",
          clientId,
          eventId: registration.eventId,
          payload: { id: registration.eventId, accessIds },
          ts: Date.now(),
        },
      ];
      await emitRegistrationEventsAndSyncNetworking(tx, pending);
      return photo;
    });
    if (networkingPhoto)
      await deleteNetworkingPhoto(networkingPhoto.photoUrl, networkingPhoto.eventId, networkingPhoto.id);
  }

  // ==========================================================================
  // Confirm payment (admin) — strict transition
  // ==========================================================================

  async confirmPayment(
    id: string,
    input: UpdatePaymentInput,
    performedBy?: string,
    ipAddress?: string,
  ): Promise<AdminRegistration> {
    await withTxn(async (tx) => {
      const old = await requireRegistrationForMutation(id, tx);
      assertRegistrationWritable(old);

      validatePaymentTransition(old.paymentStatus, input.paymentStatus);

      const { netAmount } = calculateSettlement(old);
      const effectivePaidAmount = input.paidAmount ?? netAmount;
      if (effectivePaidAmount > netAmount) {
        throw badRequest("Paid amount cannot exceed registration total", { code: ErrorCodes.BAD_REQUEST });
      }
      // ponytail: legacy logger.warn on partial-amount confirm dropped (non-behavioral).

      const newStatus = input.paymentStatus;
      const nextPaidAmount = effectivePaidAmount;
      const nextPaymentMethod = input.paymentMethod ?? old.paymentMethod;
      const patch: RegistrationPatch = {
        paymentStatus: newStatus,
        paidAmount: nextPaidAmount,
        paymentMethod: nextPaymentMethod,
        paymentReference: input.paymentReference ?? old.paymentReference,
        paymentProofUrl: input.paymentProofUrl ?? old.paymentProofUrl,
      };
      if (isFullySettled(newStatus)) {
        patch.paidAt = new Date();
      }
      await updateRegistrationRow(id, patch, tx);

      await insertAuditLog(
        {
          entityType: "Registration",
          entityId: id,
          action: "PAYMENT_CONFIRMED",
          changes: {
            paymentStatus: { old: old.paymentStatus, new: newStatus },
            paidAmount: { old: old.paidAmount, new: nextPaidAmount },
            paymentMethod: { old: old.paymentMethod, new: nextPaymentMethod },
          },
          performedBy: performedBy ?? null,
          ipAddress: ipAddress ?? null,
        },
        tx,
      );

      await syncPaidCount(this.access, 
        tx,
        { id, eventId: old.eventId, priceBreakdown: old.priceBreakdown },
        old.paymentStatus,
        input.paymentStatus,
      );

      const wasSettled = isFullySettled(old.paymentStatus);
      const isSettled = isFullySettled(input.paymentStatus);
      const clientId = old.event.clientId;
      const pending: AppEvent[] = [
        {
          type:
            !wasSettled && isSettled
              ? "registration.paymentConfirmed"
              : "registration.updated",
          clientId,
          eventId: old.eventId,
          payload: { id, paymentStatus: input.paymentStatus },
          ts: Date.now(),
        },
      ];
      if (wasSettled !== isSettled) {
        const breakdown = old.priceBreakdown as PriceBreakdown;
        const accessIds = breakdown.accessItems?.map((a) => a.accessId) ?? [];
        pending.push({
          type: "eventAccess.countsChanged",
          clientId,
          eventId: old.eventId,
          payload: { id: old.eventId, accessIds },
          ts: Date.now(),
        });
      }
      await emitRegistrationEventsAndSyncNetworking(tx, pending);

      if (input.paymentStatus === "PAID" && old.paymentStatus !== "PAID") {
        await enqueueTriggeredEmailOutbox(
          tx,
          {
            trigger: "PAYMENT_CONFIRMED",
            eventId: old.eventId,
            registration: {
              id,
              email: old.email,
              firstName: old.firstName ?? null,
              lastName: old.lastName ?? null,
            },
          },
          `email:triggered:PAYMENT_CONFIRMED:${id}`,
        );
      }
    });

    return this.read.getStrippedById(id);
  }
}
