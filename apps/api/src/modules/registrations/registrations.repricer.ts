import { isDeepStrictEqual } from "node:util";
import { Injectable } from "@nestjs/common";
import {
  ErrorCodes,
  type AppEvent,
  type PriceBreakdown,
  type AdminEditRegistrationInput,
  type PublicEditRegistrationInput,
} from "@app/contracts";
import { calculateSettlement, isFullySettled } from "@app/shared";
import {
  withLockingTxn,
  lockRegistrationForUpdate,
  settleRegistrationTxn,
  applyRegistrationSettlement,
  emitSettlementEvents,
  settlementEventPair,
  getRegistrationFormSchemaForEvent,
  registrationExistsByEmailForm,
  findRegistrationForMutation,
  findRegistrationWithFormEvent,
  type DbExecutor,
  type RegistrationFieldsPatch,
  type RegistrationSettlementWrite,
  type SettleRegistrationOptions,
  type SettleRegistrationResult,
} from "@app/db";
import { AccessService, toAccessAppException } from "../access/access.service";
import { PricingService } from "../pricing/pricing.service";
import { prepareFormDataForPricing } from "../pricing/form-data-for-pricing";
import { assertEventWritable } from "../events";
import {
  assertModuleEnabledForClient,
  type ClientModuleState,
} from "../clients/module-gates";
import { AppException } from "../../core/app-exception";
import { validateAdminPaymentOverride } from "./payment-transitions";
import { RegistrationSideEffects } from "./registrations.side-effects";
import { assertSelfEditAllowed, evaluateEditPolicy } from "./edit-policy";
import {
  assertPaidAmountWithinNet,
  assertPaidInFull,
  assertValidSelections,
  netOf,
} from "./registrations.guards";
import { toPublicRegistration, type PublicRegistration } from "./registrations.mappers";
import {
  getEnrichedRow,
  getStrippedById,
  normalizeEmail,
  type AdminRegistration,
} from "./registrations.shared";

/**
 * Per access item, how the selected quantity changes from `before` to
 * `after` (items listed twice are summed). Unchanged items are left out; the
 * rest are in ascending access id order, so concurrent edits take the
 * access rows in the same order.
 */
function accessQuantityDeltas(
  before: ReadonlyArray<{ accessId: string; quantity: number }>,
  after: ReadonlyArray<{ accessId: string; quantity: number }>,
): Array<{ accessId: string; delta: number }> {
  const deltas = new Map<string, number>();
  for (const item of before) deltas.set(item.accessId, (deltas.get(item.accessId) ?? 0) - item.quantity);
  for (const item of after) deltas.set(item.accessId, (deltas.get(item.accessId) ?? 0) + item.quantity);
  return [...deltas]
    .filter(([, delta]) => delta !== 0)
    .map(([accessId, delta]) => ({ accessId, delta }))
    .sort((a, b) => (a.accessId < b.accessId ? -1 : a.accessId > b.accessId ? 1 : 0));
}

export type EditRegistrationPublicResult = {
  registration: PublicRegistration;
  priceBreakdown: PriceBreakdown;
};

/**
 * The registration edits that reprice (plan 2.6c): the admin edit and the
 * public self-edit, both through `repriceRegistration` under the
 * registration lock.
 */
@Injectable()
export class RegistrationRepricer {
  constructor(
    private readonly access: AccessService,
    private readonly pricing: PricingService,
    private readonly sideEffects: RegistrationSideEffects,
  ) {}

  /**
   * Reprice a registration under its lock (plan 2.6), for the admin and the
   * public edit:
   * - price the answers and selections without sponsorship codes: the
   *   sponsorship comes from the linked usages, recomputed by the settlement.
   *   Without usages, the amount priced at signup (an unlinked code) is kept,
   *   capped at the new subtotal;
   * - move the access registered counters by the quantity delta (before the
   *   settlement, whose paid places they are checked against);
   * - settle: `decide` sees the new net and may refuse it or set the status
   *   and paid amount, otherwise the status is derived. Paid places move by
   *   the old → new delta and the breakdown, amounts and `fields` are
   *   written in one update;
   * - drop items that became full from unsettled registrations.
   */
  private async repriceRegistration(
    tx: DbExecutor,
    current: {
      id: string;
      eventId: string;
      totalAmount: number;
      sponsorshipAmount: number;
      priceBreakdown: unknown;
    },
    input: {
      formData: Record<string, unknown>;
      accessSelections: Array<{ accessId: string; quantity: number }>;
      /** Keep total_amount at least its stored value (payment received). */
      keepHigherTotal?: boolean;
      decide: NonNullable<SettleRegistrationOptions["decide"]>;
      fields: RegistrationFieldsPatch;
    },
  ): Promise<{
    settled: SettleRegistrationResult;
    accessDeltas: Array<{ accessId: string; delta: number }>;
  }> {
    const stored = current.priceBreakdown as PriceBreakdown | null;
    const priced = await this.pricing.calculatePrice(
      current.eventId,
      {
        formData: input.formData,
        selectedAccessItems: input.accessSelections.map((s) => ({
          accessId: s.accessId,
          quantity: s.quantity,
        })),
        sponsorshipCodes: [],
      },
      tx,
    );
    const priceBreakdown: PriceBreakdown = {
      ...priced,
      sponsorships: stored?.sponsorships ?? [],
      sponsorshipTotal: current.sponsorshipAmount,
    };

    const accessDeltas = accessQuantityDeltas(stored?.accessItems ?? [], input.accessSelections);
    for (const { accessId, delta } of accessDeltas) {
      if (delta > 0) {
        await this.access.incrementAccessRegisteredCountTx(accessId, delta, tx);
      } else {
        await this.access.decrementAccessRegisteredCountTx(accessId, -delta, tx);
      }
    }

    const settled = await settleRegistrationTxn(tx, current.id, {
      priceBreakdown,
      totalAmount: input.keepHigherTotal
        ? Math.max(current.totalAmount, priced.subtotal)
        : priced.subtotal,
      decide: input.decide,
      fields: input.fields,
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
    await this.access.handleCapacityReached(
      current.eventId,
      settled.paidAccess.incremented,
      tx,
    );
    return { settled, accessDeltas };
  }

  // ==========================================================================
  // Admin full edit (override table: any status change but out of REFUNDED)
  // ==========================================================================

  async adminEditRegistration(
    eventId: string,
    id: string,
    input: AdminEditRegistrationInput,
    adminUserId: string,
  ): Promise<AdminRegistration> {
    // Lock first, then decide from the row re-read under the lock (ADR 0001):
    // a concurrent confirmation is either seen or waits for this edit.
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
      if (registration.eventId !== eventId) {
        throw new AppException(
          ErrorCodes.CHECKIN_EVENT_MISMATCH,
          "Registration does not belong to this event",
          400,
        );
      }
      assertEventWritable(registration.event);
      assertModuleEnabledForClient(
        registration.event.client as ClientModuleState,
        "registrations",
      );

      const fields: RegistrationFieldsPatch = {};
      const changes: Record<string, { old: unknown; new: unknown }> = {};
      const hasPriceEdits =
        input.accessSelections !== undefined || input.formData !== undefined;

      const inputEmail =
        input.email !== undefined ? normalizeEmail(input.email) : undefined;
      if (inputEmail !== undefined && inputEmail !== registration.email) {
        if (await registrationExistsByEmailForm(inputEmail, registration.formId, tx, id)) {
          throw new AppException(
            ErrorCodes.REGISTRATION_ALREADY_EXISTS,
            "A registration with this email already exists for this form",
            409,
          );
        }
        fields.email = inputEmail;
        changes.email = { old: registration.email, new: inputEmail };
      }
      if (input.firstName !== undefined && input.firstName !== registration.firstName) {
        fields.firstName = input.firstName;
        changes.firstName = { old: registration.firstName, new: input.firstName };
      }
      if (input.lastName !== undefined && input.lastName !== registration.lastName) {
        fields.lastName = input.lastName;
        changes.lastName = { old: registration.lastName, new: input.lastName };
      }
      if (input.phone !== undefined && input.phone !== registration.phone) {
        fields.phone = input.phone;
        changes.phone = { old: registration.phone, new: input.phone };
      }
      // Admin answers: visible fields only, type-checked, required not
      // enforced; stored and priced as returned.
      const editedFormData =
        input.formData !== undefined
          ? prepareFormDataForPricing(
              (await getRegistrationFormSchemaForEvent(eventId, tx))?.schema,
              input.formData,
              { enforceRequired: false },
            )
          : undefined;
      if (editedFormData !== undefined) {
        fields.formData = editedFormData;
        changes.formData = { old: "(previous)", new: "(updated)" };
      }
      if (input.role !== undefined && input.role !== registration.role) {
        fields.role = input.role;
        changes.role = { old: registration.role, new: input.role };
      }
      if (input.note !== undefined && input.note !== registration.note) {
        fields.note = input.note;
        changes.note = { old: registration.note, new: input.note };
      }

      // Payment fields — admin-override transitions (nothing leaves REFUNDED).
      const statusChange =
        input.paymentStatus !== undefined &&
        input.paymentStatus !== registration.paymentStatus
          ? input.paymentStatus
          : undefined;
      if (statusChange !== undefined) {
        validateAdminPaymentOverride(registration.paymentStatus, statusChange);
        changes.paymentStatus = { old: registration.paymentStatus, new: statusChange };
      }
      // A status newly fully settled gets a payment date; others keep theirs.
      const statusPaidAt =
        statusChange !== undefined && isFullySettled(statusChange) && !registration.paidAt
          ? new Date()
          : undefined;
      if (
        input.paymentMethod !== undefined &&
        input.paymentMethod !== registration.paymentMethod
      ) {
        fields.paymentMethod = input.paymentMethod;
        changes.paymentMethod = {
          old: registration.paymentMethod,
          new: input.paymentMethod,
        };
      }
      if (input.paymentReference !== undefined)
        fields.paymentReference = input.paymentReference;
      if (input.paymentProofUrl !== undefined)
        fields.paymentProofUrl = input.paymentProofUrl;
      if (input.labName !== undefined) fields.labName = input.labName;
      fields.lastEditedAt = new Date();

      let newStatus: string = statusChange ?? registration.paymentStatus;
      let movedAccessIds: string[] = [];
      if (hasPriceEdits) {
        // Price-affecting edit: reprice, then settle against the new net.
        assertModuleEnabledForClient(
          registration.event.client as ClientModuleState,
          "pricing",
        );
        const effectiveFormData =
          editedFormData ??
          (registration.formData as Record<string, unknown>) ??
          {};
        const oldAccessItems = (
          (registration.priceBreakdown as PriceBreakdown | null)?.accessItems ?? []
        ).map((item) => ({ accessId: item.accessId, quantity: item.quantity }));
        const effectiveAccessSelections = (input.accessSelections ?? oldAccessItems).map(
          (s) => ({ accessId: s.accessId, quantity: s.quantity }),
        );
        if (
          input.accessSelections !== undefined &&
          effectiveAccessSelections.length > 0
        ) {
          await assertValidSelections(this.access, eventId, effectiveAccessSelections, effectiveFormData, {
            existingAccessIds: new Set(registration.accessTypeIds ?? []),
            exec: tx,
          });
        }
        fields.accessTypeIds = effectiveAccessSelections.map((s) => s.accessId);

        const { settled, accessDeltas } = await this.repriceRegistration(tx, registration, {
          formData: effectiveFormData,
          accessSelections: effectiveAccessSelections,
          fields,
          decide: ({ before, net }) => {
            const currentNet = netOf(before);
            const netChanged = net !== currentNet;
            // A PAID registration whose price moves: the admin says how the
            // payment follows (an amount, or another status).
            if (
              before.paymentStatus === "PAID" &&
              netChanged &&
              input.paymentStatus === undefined &&
              input.paidAmount === undefined
            ) {
              throw new AppException(
                ErrorCodes.PAYMENT_ADJUSTMENT_REQUIRED,
                "This edit changes the price of a paid registration; set the paid amount or the payment status",
                409,
                { currentNet, newNet: net, paidAmount: before.paidAmount },
              );
            }
            // Setting PAID without an amount means paid in full (plan 2.1).
            const paidAmount =
              input.paidAmount ?? (input.paymentStatus === "PAID" ? net : undefined);
            const nextPaid = paidAmount ?? before.paidAmount;
            assertPaidAmountWithinNet(nextPaid, net);
            const staysPaid =
              (input.paymentStatus ?? before.paymentStatus) === "PAID";
            if (before.paymentStatus === "PAID" && netChanged && staysPaid) {
              assertPaidInFull(nextPaid, net);
            }
            // No status given: derived from the amounts (sticky statuses stay).
            return { paymentStatus: input.paymentStatus, paidAmount, paidAt: statusPaidAt };
          },
        });

        const { before, after } = settled;
        newStatus = after.paymentStatus;
        if (after.paymentStatus !== before.paymentStatus && changes.paymentStatus === undefined) {
          changes.paymentStatus = { old: before.paymentStatus, new: after.paymentStatus };
        }
        if (after.paidAmount !== before.paidAmount) {
          changes.paidAmount = { old: before.paidAmount, new: after.paidAmount };
        }
        if (input.accessSelections !== undefined) {
          changes.accessSelections = {
            old: registration.accessTypeIds ?? [],
            new: fields.accessTypeIds,
          };
        }
        changes.totalAmount = { old: before.totalAmount, new: after.totalAmount };
        movedAccessIds = [
          ...accessDeltas.map((c) => c.accessId),
          ...settled.paidAccess.incremented,
          ...settled.paidAccess.decremented,
        ];
      } else {
        // Payment-only edit: the given status and amount, validated against
        // the stored net.
        const settlement: RegistrationSettlementWrite = {};
        if (statusChange !== undefined) settlement.paymentStatus = statusChange;
        if (statusPaidAt !== undefined) settlement.paidAt = statusPaidAt;
        const net = calculateSettlement(registration).netAmount;
        // Setting PAID without an amount means paid in full (plan 2.1).
        const paidAmount =
          input.paidAmount !== undefined
            ? input.paidAmount !== registration.paidAmount
              ? input.paidAmount
              : undefined
            : input.paymentStatus === "PAID"
              ? net
              : undefined;
        if (paidAmount !== undefined) {
          assertPaidAmountWithinNet(paidAmount, net);
          settlement.paidAmount = paidAmount;
          if (paidAmount !== registration.paidAmount) {
            changes.paidAmount = { old: registration.paidAmount, new: paidAmount };
          }
        }
        await applyRegistrationSettlement(tx, { registrationId: id, settlement, fields });
        if (statusChange !== undefined) {
          await this.sideEffects.syncPaidCount(
            tx,
            { id, eventId, priceBreakdown: registration.priceBreakdown },
            registration.paymentStatus,
            statusChange,
          );
        }
      }

      if (Object.keys(changes).length > 0) {
        await this.sideEffects.audit(tx, {
          entityId: id,
          action: "UPDATE",
          changes,
          performedBy: adminUserId,
        });
      }

      const pending = settlementEventPair({
        id,
        eventId,
        clientId: registration.event.clientId,
        oldStatus: registration.paymentStatus,
        newStatus,
        emitCountsChanged: newStatus !== registration.paymentStatus || movedAccessIds.length > 0,
        accessIds: [...new Set(movedAccessIds)],
      });
      await emitSettlementEvents(tx, pending);
    });

    return getStrippedById(id);
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
      throw new AppException(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid expectedUpdatedAt precondition",
        400,
      );
    }

    let newPriceBreakdown!: PriceBreakdown;

    // Lock first, then decide from the row re-read under the lock (ADR 0001).
    await withLockingTxn(async (tx) => {
      const locked = await lockRegistrationForUpdate(tx, registrationId);
      const current = locked
        ? await findRegistrationWithFormEvent(registrationId, tx)
        : null;
      if (!current) {
        throw new AppException(
          ErrorCodes.REGISTRATION_NOT_FOUND,
          "Registration not found",
          404,
        );
      }

      const isAccessEdit = input.accessSelections !== undefined;
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
      const accessDeltas = accessQuantityDeltas(currentAccessItems, newAccessSelections);

      // The same policy GET-for-edit shows, enforced on the fresh row.
      const policy = evaluateEditPolicy({
        registration: current,
        event: current.event,
        now: new Date(),
      });
      assertSelfEditAllowed(policy, current.event.client as ClientModuleState, {
        changesAccess: isAccessEdit,
        removedAccessIds: accessDeltas.filter((c) => c.delta < 0).map((c) => c.accessId),
      });

      const currentFormData =
        (current.formData as Record<string, unknown> | null) ?? {};
      const newFormData = input.formData
        ? prepareFormDataForPricing(current.form.schema, {
            ...currentFormData,
            ...input.formData,
          })
        : currentFormData;
      const formDataChanged =
        input.formData !== undefined && !isDeepStrictEqual(newFormData, currentFormData);
      // Reprice only when something priced changed: a name or phone edit
      // leaves the price (and the payment status) as they are.
      const reprice = formDataChanged || accessDeltas.length > 0;

      if (reprice) {
        await assertValidSelections(this.access, current.eventId, newAccessSelections, newFormData, {
          existingAccessIds: currentAccessIds,
          exec: tx,
        });
        await this.access.assertAccessSelectionRequirement(
          current.eventId,
          newFormData,
          newAccessSelections,
          (current.form.schema as { settings?: { accessSelectionRequired?: boolean } } | null)
            ?.settings,
          tx,
        );
      }

      // Optimistic precondition from GET-for-edit, on the locked row.
      if (current.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
        throw new AppException(
          ErrorCodes.CONCURRENT_MODIFICATION,
          "Registration changed. Refresh and try again.",
          409,
        );
      }

      const fields: RegistrationFieldsPatch = {
        formData: newFormData,
        firstName: input.firstName ?? current.firstName,
        lastName: input.lastName ?? current.lastName,
        phone: input.phone ?? current.phone,
        accessTypeIds: newAccessSelections.map((s) => s.accessId),
        lastEditedAt: new Date(),
      };
      let nextPaymentStatus = current.paymentStatus;
      const countsChangedIds = new Set(accessDeltas.map((c) => c.accessId));
      if (reprice) {
        const { settled } = await this.repriceRegistration(tx, current, {
          formData: newFormData,
          accessSelections: newAccessSelections,
          keepHigherTotal: policy.paymentReceived,
          fields,
          decide: ({ before, net }) => {
            // PAID means paid in full: a self-edit may not change the price.
            const currentNet = netOf(before);
            if (before.paymentStatus === "PAID" && net !== currentNet) {
              throw new AppException(
                ErrorCodes.REGISTRATION_PRICE_LOCKED,
                "This change would alter the price of a paid registration",
                409,
                { currentNet, newNet: net },
              );
            }
            return undefined;
          },
        });
        nextPaymentStatus = settled.after.paymentStatus;
        newPriceBreakdown = settled.after.priceBreakdown;
        for (const accessId of [
          ...settled.paidAccess.incremented,
          ...settled.paidAccess.decremented,
        ]) {
          countsChangedIds.add(accessId);
        }
      } else {
        await applyRegistrationSettlement(tx, { registrationId, settlement: {}, fields });
        newPriceBreakdown = currentPriceBreakdown;
      }

      const auditChanges: Record<string, { old: unknown; new: unknown }> = {};
      if (formDataChanged) {
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
      if (accessDeltas.length > 0) {
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
        await this.sideEffects.audit(tx, {
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
      if (countsChangedIds.size > 0) {
        pending.push({
          type: "eventAccess.countsChanged",
          clientId,
          eventId: current.eventId,
          payload: { id: current.eventId, accessIds: [...countsChangedIds] },
          ts: Date.now(),
        });
      }
      await emitSettlementEvents(tx, pending);
    });

    const registration = toPublicRegistration(await getEnrichedRow(registrationId));
    return { registration, priceBreakdown: newPriceBreakdown };
  }
}
