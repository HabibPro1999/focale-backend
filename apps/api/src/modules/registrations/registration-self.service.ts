import {
  ErrorCodes,
  type AppEvent,
  type PriceBreakdown,
  type PublicEditRegistrationInput,
  type SelectPaymentMethodInput,
} from "@app/contracts";
import {
  casUpdateRegistrationByUpdatedAt,
  findAccessDetailsByIds,
  findRegistrationWithFormEvent,
  getRegistrationEditToken,
  updateRegistrationRow,
  withTxn,
} from "@app/db";
import { calculateSettlement, isFullySponsored as hasFullSponsorship, hasReceivedPayment } from "@app/shared";
import { Injectable } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import { badRequest, conflict, notFound } from "../../core/app-exception";
import { quantitiesByAccess, quantityDeltas } from "../access/access-quantities";
import { AccessService } from "../access/access.service";
import { assertModuleEnabledForClient, isModuleEnabledForClient } from "../clients/module-gates";
import { assertEventAcceptsPublicActions } from "../events";
import { prepareFormDataForPricing } from "../pricing/form-data-for-pricing";
import { PricingService } from "../pricing/pricing.service";
import { breakdownColumns } from "./registrations.enrichment";
import { assertLabSponsorshipAllowed, requireRegistrationForPublicAction } from "./registrations.guards";
import { toPublicRegistration, type PublicRegistration } from "./registrations.mappers";
import { RegistrationsReadService } from "./registrations.read.service";
import { recalculateLinkedSponsorshipSettlement } from "./registrations.settlement";
import { audit, emitRegistrationEventsAndSyncNetworking } from "./registrations.side-effects";

export type GetRegistrationForEditResult = {
  registration: PublicRegistration;
  expectedUpdatedAt: string;
  canEdit: boolean;
  canEditPersonalInfo: boolean;
  canEditAccess: boolean;
  canAddAccess: boolean;
  canRemoveAccess: boolean;
  isFullySponsored: boolean;
  amountDue: number;
  editRestrictions: string[];
};

export type EditRegistrationPublicResult = {
  registration: PublicRegistration;
  priceBreakdown: PriceBreakdown;
};

@Injectable()
export class RegistrationSelfService {
  constructor(
    private readonly access: AccessService,
    private readonly pricing: PricingService,
    private readonly read: RegistrationsReadService,
  ) {}

  // ==========================================================================
  // Edit-token verification (timing-safe, no expiry)
  // ==========================================================================

  async verifyEditToken(registrationId: string, token: string): Promise<boolean> {
    const row = await getRegistrationEditToken(registrationId);
    if (!row?.editToken) return false;
    try {
      return timingSafeEqual(
        Buffer.from(row.editToken, "utf8"),
        Buffer.from(token, "utf8"),
      );
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // Public self-service: get-for-edit
  // ==========================================================================

  async getRegistrationForEdit(
    registrationId: string,
  ): Promise<GetRegistrationForEditResult> {
    const registration = await findRegistrationWithFormEvent(registrationId);
    if (!registration) {
      throw notFound("Registration not found", { code: ErrorCodes.REGISTRATION_NOT_FOUND });
    }

    const priceBreakdown = registration.priceBreakdown as PriceBreakdown;
    const accessIds = priceBreakdown.accessItems?.map((i) => i.accessId) ?? [];
    const details =
      accessIds.length > 0 ? await findAccessDetailsByIds(accessIds) : [];
    const accessMap = new Map(details.map((a) => [a.id, a]));
    const accessSelections = (priceBreakdown.accessItems ?? []).map((item) => ({
      id: `${registration.id}-${item.accessId}`,
      accessId: item.accessId,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      subtotal: item.subtotal,
      access:
        accessMap.get(item.accessId) ?? {
          id: item.accessId,
          name: String(item.name ?? item.accessId),
          type: "OTHER",
          startsAt: null,
          endsAt: null,
        },
    }));

    const restrictions: string[] = [];
    let canEdit = true;
    let canEditPersonalInfo = true;
    let canEditAccess = true;
    let canAddAccess = true;
    let canRemoveAccess = true;
    let isFullySponsored = false;

    const blockAll = (reason: string) => {
      canEdit = false;
      canEditPersonalInfo = false;
      canEditAccess = false;
      canAddAccess = false;
      canRemoveAccess = false;
      restrictions.push(reason);
    };

    if (registration.paymentStatus === "REFUNDED") {
      blockAll("Registration has been refunded");
    }
    if (
      registration.event.status !== "OPEN" ||
      registration.event.endDate < new Date()
    ) {
      blockAll("Event is not accepting changes");
    }
    if (!isModuleEnabledForClient(registration.event.client, "registrations")) {
      blockAll("Registrations are disabled for this event");
    }
    if (!isModuleEnabledForClient(registration.event.client, "pricing")) {
      blockAll("Pricing is disabled for this event");
    }
    if (registration.paymentStatus === "VERIFYING") {
      canEditAccess = false;
      canAddAccess = false;
      canRemoveAccess = false;
      restrictions.push("Payment proof is under review");
    }
    const isPaid =
      hasReceivedPayment(registration);
    if (isPaid) {
      canRemoveAccess = false;
      restrictions.push("Cannot remove access items (payment received)");
    }
    if (registration.paymentStatus === "WAIVED") {
      canEditAccess = false;
      canAddAccess = false;
      canRemoveAccess = false;
      restrictions.push("Waived registrations cannot modify access selections");
    }
    if (
      hasFullSponsorship(registration)
    ) {
      isFullySponsored = true;
      canEditAccess = false;
      canAddAccess = false;
      canRemoveAccess = false;
      restrictions.push(
        "Fully sponsored registration cannot modify access selections",
      );
    }

    const { amountDue } = calculateSettlement({
      totalAmount: registration.totalAmount,
      paidAmount: registration.paidAmount,
      sponsorshipAmount: registration.sponsorshipAmount,
    });

    return {
      registration: toPublicRegistration({ ...registration, accessSelections }),
      expectedUpdatedAt: registration.updatedAt.toISOString(),
      canEdit,
      canEditPersonalInfo,
      canEditAccess,
      canAddAccess,
      canRemoveAccess,
      isFullySponsored,
      amountDue,
      editRestrictions: restrictions,
    };
  }

  // ==========================================================================
  // Public self-service: edit (optimistic CAS on updatedAt)
  // ==========================================================================

  async editRegistrationPublic(
    registrationId: string,
    input: PublicEditRegistrationInput,
  ): Promise<EditRegistrationPublicResult> {
    const expectedUpdatedAt = new Date(input.expectedUpdatedAt);
    if (Number.isNaN(expectedUpdatedAt.getTime())) {
      throw badRequest("Invalid expectedUpdatedAt precondition");
    }

    let newPriceBreakdown!: PriceBreakdown;

    await withTxn(async (tx) => {
      const current = await findRegistrationWithFormEvent(registrationId, tx);
      if (!current) {
        throw notFound("Registration not found", { code: ErrorCodes.REGISTRATION_NOT_FOUND });
      }

      if (current.paymentStatus === "REFUNDED") {
        throw badRequest("Refunded registrations cannot be edited", { code: ErrorCodes.REGISTRATION_REFUNDED });
      }

      try {
        assertEventAcceptsPublicActions(current.event);
      } catch {
        throw badRequest("Event is not accepting changes", { code: ErrorCodes.REGISTRATION_EDIT_FORBIDDEN });
      }

      assertModuleEnabledForClient(
        current.event.client,
        "registrations",
      );
      assertModuleEnabledForClient(
        current.event.client,
        "pricing",
      );

      const isAccessEdit = input.accessSelections !== undefined;

      if (current.paymentStatus === "VERIFYING" && isAccessEdit) {
        throw badRequest("Cannot modify access while payment is under review", { code: ErrorCodes.REGISTRATION_VERIFYING_BLOCKED });
      }
      if (current.paymentStatus === "WAIVED" && isAccessEdit) {
        throw badRequest("Waived registrations cannot modify access selections", { code: ErrorCodes.REGISTRATION_WAIVED_ACCESS_BLOCKED });
      }
      if (
        hasFullSponsorship(current) &&
        isAccessEdit
      ) {
        throw badRequest("Fully sponsored registrations cannot modify access selections", { code: ErrorCodes.REGISTRATION_FULLY_SPONSORED_BLOCKED });
      }

      const currentFormData =
        (current.formData as Record<string, unknown> | null) ?? {};
      let newFormData: Record<string, unknown> = input.formData
        ? { ...currentFormData, ...input.formData }
        : currentFormData;

      if (input.formData) {
        newFormData = prepareFormDataForPricing(current.form.schema, newFormData);
      }

      const currentPriceBreakdown =
        (current.priceBreakdown as PriceBreakdown | null) ??
        ({ accessItems: [] } as unknown as PriceBreakdown);
      const currentAccessItems = currentPriceBreakdown.accessItems ?? [];
      const currentAccessIds = new Set(currentAccessItems.map((i) => i.accessId));

      const newAccessSelections =
        input.accessSelections ??
        currentAccessItems.map((item) => ({
          accessId: item.accessId,
          quantity: item.quantity,
        }));

      const accessDeltas = quantityDeltas(
        quantitiesByAccess(currentAccessItems),
        quantitiesByAccess(newAccessSelections),
      );

      const currentIsPaid =
        hasReceivedPayment(current);
      const negativeDeltas = accessDeltas.filter((c) => c.delta < 0);
      if (currentIsPaid && negativeDeltas.length > 0) {
        throw badRequest("Cannot remove access items from a paid registration", { code: ErrorCodes.REGISTRATION_ACCESS_REMOVAL_BLOCKED, details: {
            message: "Paid registrations can only add new access items",
            attemptedRemovals: negativeDeltas.map((c) => c.accessId),
          } });
      }

      if (isAccessEdit || input.formData !== undefined) {
        await this.access.assertAccessSelectionsValid(
          current.eventId,
          newAccessSelections,
          newFormData,
          currentAccessIds,
          tx,
        );
      }

      if (isAccessEdit || input.formData !== undefined) {
        await this.access.assertAccessSelectionRequirement(current.eventId, newFormData, newAccessSelections,
          current.form.schema, tx);
      }

      newPriceBreakdown = await this.pricing.calculatePrice(
        current.eventId,
        {
          formData: newFormData,
          selectedAccessItems: newAccessSelections.map((s) => ({
            accessId: s.accessId,
            quantity: s.quantity,
          })),
          sponsorshipCodes: current.sponsorshipCode ? [current.sponsorshipCode] : [],
        },
        tx,
      );

      const newTotalAmount = currentIsPaid
        ? Math.max(current.totalAmount, newPriceBreakdown.subtotal)
        : newPriceBreakdown.subtotal;
      const settlement = await recalculateLinkedSponsorshipSettlement(
        tx,
        current,
        newPriceBreakdown,
        newTotalAmount,
      );
      newPriceBreakdown = settlement.priceBreakdown;
      const nextPaymentStatus = settlement.paymentStatus ?? current.paymentStatus;
      const nextPaidAt =
        settlement.paymentStatus !== undefined ? settlement.paidAt ?? null : current.paidAt;

      await Promise.all(
        accessDeltas
          .filter((c) => c.delta > 0)
          .map((c) =>
            this.access.incrementAccessRegisteredCountTx(c.accessId, c.delta, tx),
          ),
      );
      if (!currentIsPaid) {
        await Promise.all(
          accessDeltas
            .filter((c) => c.delta < 0)
            .map((c) =>
              this.access.decrementAccessRegisteredCountTx(
                c.accessId,
                Math.abs(c.delta),
                tx,
              ),
            ),
        );
      }

      if (
        (isAccessEdit && accessDeltas.length > 0) ||
        nextPaymentStatus !== current.paymentStatus
      ) {
        const currentCovered =
          current.paymentStatus === "PARTIAL"
            ? await this.access.getAlreadyCoveredAccessIds(registrationId, tx)
            : new Set<string>();
        await this.access.syncPaidCountDelta(
          current.eventId,
          {
            status: current.paymentStatus,
            priceBreakdown: currentPriceBreakdown,
            coveredAccessIds: currentCovered,
          },
          {
            status: nextPaymentStatus,
            priceBreakdown: newPriceBreakdown,
            coveredAccessIds: settlement.coveredAccessIds,
          },
          tx,
        );
      }

      const affected = await casUpdateRegistrationByUpdatedAt(
        registrationId,
        expectedUpdatedAt,
        {
          formData: newFormData,
          firstName: input.firstName ?? current.firstName,
          lastName: input.lastName ?? current.lastName,
          phone: input.phone ?? current.phone,
          totalAmount: newTotalAmount,
          ...breakdownColumns(newPriceBreakdown),
          sponsorshipAmount: settlement.sponsorshipAmount,
          paymentStatus: nextPaymentStatus,
          paidAt: nextPaidAt,
          accessTypeIds: newAccessSelections.map((s) => s.accessId),
          lastEditedAt: new Date(),
        },
        tx,
      );

      if (affected === 0) {
        throw conflict("Registration changed. Refresh and try again.", { code: ErrorCodes.CONCURRENT_MODIFICATION });
      }

      const auditChanges: Record<string, { old: unknown; new: unknown }> = {};
      if (input.formData) {
        auditChanges.formData = { old: currentFormData, new: newFormData };
      }
      if (input.firstName !== undefined && input.firstName !== current.firstName) {
        auditChanges.firstName = { old: current.firstName, new: input.firstName };
      }
      if (input.lastName !== undefined && input.lastName !== current.lastName) {
        auditChanges.lastName = { old: current.lastName, new: input.lastName };
      }
      if (input.phone !== undefined && input.phone !== current.phone) {
        auditChanges.phone = { old: current.phone, new: input.phone };
      }
      if (isAccessEdit && accessDeltas.length > 0) {
        auditChanges.accessSelections = {
          old: currentAccessItems.map((i) => ({
            accessId: i.accessId,
            quantity: i.quantity,
          })),
          new: newAccessSelections.map((s) => ({
            accessId: s.accessId,
            quantity: s.quantity,
          })),
        };
      }
      if (Object.keys(auditChanges).length > 0) {
        await audit(tx, {
          entityId: registrationId,
          action: "UPDATE",
          changes: auditChanges,
          performedBy: "PUBLIC",
        });
      }

      const clientId = current.event.clientId;
      const pending: AppEvent[] = [
        {
          type: "registration.updated",
          clientId,
          eventId: current.eventId,
          payload: { id: registrationId, paymentStatus: nextPaymentStatus },
          ts: Date.now(),
        },
      ];
      if (isAccessEdit && accessDeltas.length > 0) {
        pending.push({
          type: "eventAccess.countsChanged",
          clientId,
          eventId: current.eventId,
          payload: {
            id: current.eventId,
            accessIds: accessDeltas.map((c) => c.accessId),
          },
          ts: Date.now(),
        });
      }
      await emitRegistrationEventsAndSyncNetworking(tx, pending);
    });

    const registration = toPublicRegistration(await this.read.getEnrichedRow(registrationId));
    return { registration, priceBreakdown: newPriceBreakdown };
  }

  // ==========================================================================
  // Select payment method (public) — CASH / LAB_SPONSORSHIP; stays PENDING
  // ==========================================================================

  async selectPaymentMethod(
    registrationId: string,
    input: SelectPaymentMethodInput,
  ): Promise<void> {
    await withTxn(async (tx) => {
      const registration = await requireRegistrationForPublicAction(registrationId, ErrorCodes.NOT_FOUND, tx);

      assertLabSponsorshipAllowed(registration.event.client, input.paymentMethod);

      if (registration.paymentStatus !== "PENDING") {
        throw badRequest("Payment method can only be selected for pending registrations", { code: ErrorCodes.REGISTRATION_INVALID_STATUS });
      }

      const nextLabName =
        input.paymentMethod === "LAB_SPONSORSHIP" ? (input.labName ?? null) : null;
      const changes: Record<string, { old: unknown; new: unknown }> = {
        paymentMethod: { old: registration.paymentMethod, new: input.paymentMethod },
      };
      if (nextLabName !== registration.labName) {
        changes.labName = { old: registration.labName, new: nextLabName };
      }

      await updateRegistrationRow(
        registrationId,
        {
          paymentMethod: input.paymentMethod,
          paymentStatus: "PENDING",
          labName: nextLabName,
        },
        tx,
      );

      await audit(tx, {
        entityId: registrationId,
        action: "PAYMENT_METHOD_SELECTED",
        changes,
        performedBy: "PUBLIC",
      });
    });
  }
}
