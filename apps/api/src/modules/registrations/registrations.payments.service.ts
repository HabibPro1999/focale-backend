import { Injectable } from "@nestjs/common";
import {
  ErrorCodes,
  type AppEvent,
  type UpdateRegistrationInput,
  type UpdatePaymentInput,
  type SelectPaymentMethodInput,
} from "@app/contracts";
import { calculateSettlement, isFullySettled } from "@app/shared";
import {
  withLockingTxn,
  lockRegistrationForUpdate,
  settleRegistrationTxn,
  enqueueTriggeredEmailOutbox,
  applyRegistrationSettlement,
  emitSettlementEvents,
  settlementEventPair,
  findRegistrationForMutation,
  findRegistrationWithFormEvent,
  insertAuditLog,
  type RegistrationFieldsPatch,
  type RegistrationSettlementWrite,
} from "@app/db";
import { AccessService, toAccessAppException } from "../access/access.service";
import {
  assertEventAcceptsPublicActions,
  assertEventWritable,
} from "../events";
import {
  assertModuleEnabledForClient,
  type ClientModuleState,
} from "../clients/module-gates";
import { AppException } from "../../core/app-exception";
import { validatePaymentTransition } from "./payment-transitions";
import { RegistrationSideEffects } from "./registrations.side-effects";
import {
  assertPaidAmountWithinNet,
  assertPaidInFull,
} from "./registrations.guards";
import {
  getAdminRegistrationById,
  getStrippedById,
  type AdminRegistration,
} from "./registrations.shared";

/**
 * The payment writes on an existing registration: the admin partial update,
 * the admin payment confirmation and the public payment-method selection,
 * each under the registration lock.
 */
@Injectable()
export class RegistrationPaymentsService {
  constructor(
    private readonly access: AccessService,
    private readonly sideEffects: RegistrationSideEffects,
  ) {}

  // ==========================================================================
  // Admin partial update (payment/note/role)
  // ==========================================================================

  async updateRegistration(
    id: string,
    input: UpdateRegistrationInput,
    performedBy?: string,
  ): Promise<AdminRegistration> {
    // An empty body changes nothing: return the registration as it is, with
    // no write, audit row or event.
    if (Object.values(input).every((value) => value === undefined)) {
      const current = await getAdminRegistrationById(id);
      if (!current) {
        throw new AppException(
          ErrorCodes.REGISTRATION_NOT_FOUND,
          "Registration not found",
          404,
        );
      }
      return current;
    }

    // Lock first so a concurrent confirmation or proof upload cannot be
    // overwritten from a stale read (ADR 0001).
    await withLockingTxn(async (tx) => {
      const locked = await lockRegistrationForUpdate(tx, id);
      const registration = locked
        ? await findRegistrationForMutation(id, tx)
        : null;
      if (!registration) {
        throw new AppException(
          ErrorCodes.REGISTRATION_NOT_FOUND,
          "Registration not found",
          404,
        );
      }
      assertEventWritable(registration.event);
      assertModuleEnabledForClient(
        registration.event.client as ClientModuleState,
        "registrations",
      );

      const settlement: RegistrationSettlementWrite = {};
      const fields: RegistrationFieldsPatch = {};
      if (input.paymentStatus !== undefined) {
        validatePaymentTransition(registration.paymentStatus, input.paymentStatus);
        settlement.paymentStatus = input.paymentStatus;
        if (
          isFullySettled(input.paymentStatus) &&
          !registration.paidAt
        ) {
          settlement.paidAt = new Date();
        }
      }
      const paidAmount =
        input.paidAmount ??
        (input.paymentStatus === "PAID"
          ? calculateSettlement(registration).netAmount
          : undefined);
      if (paidAmount !== undefined) {
        assertPaidAmountWithinNet(paidAmount, calculateSettlement(registration).netAmount);
        settlement.paidAmount = paidAmount;
      }
      if (input.paymentMethod !== undefined) fields.paymentMethod = input.paymentMethod;
      if (input.paymentReference !== undefined)
        fields.paymentReference = input.paymentReference;
      if (input.paymentProofUrl !== undefined)
        fields.paymentProofUrl = input.paymentProofUrl;
      if (input.note !== undefined) fields.note = input.note;
      if (input.role !== undefined) fields.role = input.role;

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
        settlement.paidAmount !== undefined &&
        settlement.paidAmount !== registration.paidAmount
      ) {
        changes.paidAmount = {
          old: registration.paidAmount,
          new: settlement.paidAmount,
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

      await applyRegistrationSettlement(tx, { registrationId: id, settlement, fields });

      if (statusChanged) {
        await this.sideEffects.syncPaidCount(
          tx,
          registration,
          registration.paymentStatus,
          input.paymentStatus as string,
        );
      }

      if (Object.keys(changes).length > 0) {
        await this.sideEffects.audit(tx, {
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
        newStatus: input.paymentStatus as string | undefined,
        emitCountsChanged: statusChanged,
      });
      await emitSettlementEvents(tx, pending);
    });

    return getStrippedById(id);
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
    // Lock first, then decide from the row re-read under the lock (ADR 0001):
    // a concurrent proof upload, method selection or admin edit waits for this
    // confirmation, or this one waits for it and sees its result.
    await withLockingTxn(async (tx) => {
      const locked = await lockRegistrationForUpdate(tx, id);
      const old = locked ? await findRegistrationForMutation(id, tx) : null;
      if (!old) {
        throw new AppException(
          ErrorCodes.REGISTRATION_NOT_FOUND,
          "Registration not found",
          404,
        );
      }
      assertEventWritable(old.event);
      assertModuleEnabledForClient(
        old.event.client as ClientModuleState,
        "registrations",
      );

      validatePaymentTransition(old.paymentStatus, input.paymentStatus);

      const newStatus = input.paymentStatus;
      const nextPaymentMethod = input.paymentMethod ?? old.paymentMethod;
      // Settle against the fresh breakdown: sponsorship usages recomputed, the
      // paid amount checked against that net, paid places moved by the delta.
      const settled = await settleRegistrationTxn(tx, id, {
        decide: ({ net }) => {
          const paidAmount = input.paidAmount ?? net;
          assertPaidAmountWithinNet(paidAmount, net);
          if (newStatus === "PAID") assertPaidInFull(paidAmount, net);
          return {
            paymentStatus: newStatus,
            paidAmount,
            ...(isFullySettled(newStatus) ? { paidAt: new Date() } : {}),
          };
        },
        fields: {
          paymentMethod: nextPaymentMethod,
          paymentReference: input.paymentReference ?? old.paymentReference,
          paymentProofUrl: input.paymentProofUrl ?? old.paymentProofUrl,
        },
      }).catch((err: unknown) => {
        throw toAccessAppException(err);
      });
      if (!settled) {
        throw new AppException(
          ErrorCodes.REGISTRATION_NOT_FOUND,
          "Registration not found",
          404,
        );
      }
      const nextPaidAmount = settled.after.paidAmount;
      await this.access.handleCapacityReached(
        old.eventId,
        settled.paidAccess.incremented,
        tx,
      );

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
      // Paid places can also move without a settled flip (PARTIAL with
      // sponsorship-covered items), so the moved items count too.
      const movedAccessIds = [
        ...settled.paidAccess.incremented,
        ...settled.paidAccess.decremented,
      ];
      if (wasSettled !== isSettled || movedAccessIds.length > 0) {
        const breakdown = old.priceBreakdown;
        const accessIds = [
          ...new Set([
            ...(breakdown.accessItems?.map((a) => a.accessId) ?? []),
            ...movedAccessIds,
          ]),
        ];
        pending.push({
          type: "eventAccess.countsChanged",
          clientId,
          eventId: old.eventId,
          payload: { id: old.eventId, accessIds },
          ts: Date.now(),
        });
      }
      await emitSettlementEvents(tx, pending);

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

    return getStrippedById(id);
  }

  // ==========================================================================
  // Select payment method (public) — CASH / LAB_SPONSORSHIP; stays PENDING
  // ==========================================================================

  async selectPaymentMethod(
    registrationId: string,
    input: SelectPaymentMethodInput,
  ): Promise<void> {
    // Lock, re-read, then re-check PENDING on the fresh row: a registration
    // confirmed (or under proof review) meanwhile is refused, never reset to
    // PENDING. The transition table alone would allow VERIFYING → PENDING.
    await withLockingTxn(async (tx) => {
      const locked = await lockRegistrationForUpdate(tx, registrationId);
      const registration = locked
        ? await findRegistrationWithFormEvent(registrationId, tx)
        : null;
      if (!registration) {
        throw new AppException(ErrorCodes.REGISTRATION_NOT_FOUND, "Registration not found", 404);
      }
      assertEventAcceptsPublicActions(registration.event);
      assertModuleEnabledForClient(
        registration.event.client as ClientModuleState,
        "registrations",
      );

      if (
        input.paymentMethod === "LAB_SPONSORSHIP" &&
        (registration.event.client.enabledModules ?? []).includes("sponsorships")
      ) {
        throw new AppException(
          ErrorCodes.BAD_REQUEST,
          "Lab sponsorship payment method is only available when sponsorships are disabled",
          400,
        );
      }

      if (registration.paymentStatus !== "PENDING") {
        throw new AppException(
          ErrorCodes.REGISTRATION_INVALID_STATUS,
          "Payment method can only be selected for pending registrations",
          400,
        );
      }

      const nextLabName =
        input.paymentMethod === "LAB_SPONSORSHIP" ? (input.labName ?? null) : null;
      const changes: Record<string, { old: unknown; new: unknown }> = {
        paymentMethod: { old: registration.paymentMethod, new: input.paymentMethod },
      };
      if (nextLabName !== registration.labName) {
        changes.labName = { old: registration.labName, new: nextLabName };
      }

      await applyRegistrationSettlement(tx, {
        registrationId,
        settlement: { paymentStatus: "PENDING" },
        fields: { paymentMethod: input.paymentMethod, labName: nextLabName },
      });

      await this.sideEffects.audit(tx, {
        entityId: registrationId,
        action: "PAYMENT_METHOD_SELECTED",
        changes,
        performedBy: "PUBLIC",
      });
    });
  }
}
