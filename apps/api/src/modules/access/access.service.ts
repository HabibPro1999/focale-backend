import { Injectable } from "@nestjs/common";
import { ErrorCodes } from "@app/contracts";
import type {
  CreateEventAccessInput,
  UpdateEventAccessInput,
  AccessSelection,
  GroupedAccessResponse,
} from "@app/contracts";
import {
  getDb,
  withTxn,
  type DbExecutor,
  type EventAccessWithPrereqs,
  type NewEventAccessValues,
  getEventDatesForAccess,
  getEventAccessById as getEventAccessByIdQuery,
  getEventAccessForUpdate,
  getEventAccessWithPrereqs,
  listEventAccessRows,
  getAccessClientId as getAccessClientIdQuery,
  findExistingAccessIdsInEvent,
  getEventPrereqEdges,
  getActiveAccessForGrouping,
  getAccessByIdsForValidation,
  getIncludedInBaseAccess,
  insertEventAccess,
  updateEventAccessRow,
  setAccessPrerequisites,
  countRegistrationsWithAccess,
  countActiveSponsorshipsWithAccess,
  getAccessDependentIds,
  removePrerequisiteEdge,
  deleteEventAccessById,
  casIncrementAccessRegisteredCount,
  casDecrementAccessRegisteredCount,
  casIncrementAccessPaidCount,
  casDecrementAccessPaidCount,
  getAccessCapacityInfo,
  getAccessRegisteredCount,
  getAccessPaidCount,
  getAccessCapacityRowsByIds,
  getUnsettledRegistrationsWithAccess,
  getRegistrationCoveredAccessIds,
  updateRegistrationForAccessDrop,
  insertAuditLog,
  enqueueTriggeredEmailOutbox,
} from "@app/db";
import { AppException } from "../../core/app-exception";
import { groupAccess } from "./access-grouping";
import { validateSelections } from "./access-validation";

// Statuses that fully occupy paid capacity.
const FULLY_SETTLED_STATUSES = ["PAID", "SPONSORED", "WAIVED"];

// Structural view of the registration priceBreakdown JSON (recomputed by hand on
// access drops — see the port spec; we do NOT delegate to the pricing module).
interface BreakdownAccessItem {
  accessId: string;
  name?: unknown;
  unitPrice?: number;
  quantity: number;
  subtotal: number;
}
interface RegistrationBreakdown {
  calculatedBasePrice: number;
  accessItems: BreakdownAccessItem[];
  accessTotal?: number;
  subtotal?: number;
  sponsorshipTotal?: number;
  total?: number;
  droppedAccessItems?: (BreakdownAccessItem & { reason: string })[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Date-boundary validation (pure) — ported verbatim.
// ---------------------------------------------------------------------------

function validateAccessDatesAgainstEvent(
  accessDates: {
    startsAt?: Date | null;
    endsAt?: Date | null;
    availableFrom?: Date | null;
    availableTo?: Date | null;
  },
  eventDates: { startDate: Date; endDate: Date },
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const { startDate } = eventDates;

  const endDate = new Date(eventDates.endDate);
  endDate.setUTCHours(23, 59, 59, 999);

  const formatDate = (d: Date) =>
    d.toLocaleDateString("fr-FR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  const range = `${formatDate(startDate)} - ${formatDate(endDate)}`;

  if (
    accessDates.startsAt &&
    (accessDates.startsAt < startDate || accessDates.startsAt > endDate)
  ) {
    errors.push(`L'heure de début doit être dans la plage de l'événement (${range})`);
  }
  if (
    accessDates.endsAt &&
    (accessDates.endsAt < startDate || accessDates.endsAt > endDate)
  ) {
    errors.push(`L'heure de fin doit être dans la plage de l'événement (${range})`);
  }
  if (
    accessDates.availableFrom &&
    (accessDates.availableFrom < startDate || accessDates.availableFrom > endDate)
  ) {
    errors.push(
      `La date de disponibilité doit être dans la plage de l'événement (${range})`,
    );
  }
  if (
    accessDates.availableTo &&
    (accessDates.availableTo < startDate || accessDates.availableTo > endDate)
  ) {
    errors.push(`La date limite doit être dans la plage de l'événement (${range})`);
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// paidAccessQuantities (pure) — ported verbatim.
// ---------------------------------------------------------------------------

function paidAccessQuantities(
  status: string,
  priceBreakdown: unknown,
  coveredAccessIds = new Set<string>(),
): Map<string, number> {
  const quantities = new Map<string, number>();
  const isFullySettled = FULLY_SETTLED_STATUSES.includes(status);
  if (!isFullySettled && status !== "PARTIAL") {
    return quantities;
  }
  const breakdown = priceBreakdown as RegistrationBreakdown;
  for (const item of breakdown.accessItems ?? []) {
    if (isFullySettled || coveredAccessIds.has(item.accessId)) {
      quantities.set(
        item.accessId,
        (quantities.get(item.accessId) ?? 0) + item.quantity,
      );
    }
  }
  return quantities;
}

@Injectable()
export class AccessService {
  // =========================================================================
  // CRUD
  // =========================================================================

  /** Create an access item. No transaction (single insert + prereq connect). */
  async createEventAccess(
    input: CreateEventAccessInput,
  ): Promise<EventAccessWithPrereqs> {
    const { eventId, requiredAccessIds, ...data } = input;

    const event = await getEventDatesForAccess(eventId);
    if (!event) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }

    const dateValidation = validateAccessDatesAgainstEvent(
      {
        startsAt: data.startsAt,
        endsAt: data.endsAt,
        availableFrom: data.availableFrom,
        availableTo: data.availableTo,
      },
      { startDate: event.startDate, endDate: event.endDate },
    );
    if (!dateValidation.valid) {
      throw new AppException(
        ErrorCodes.ACCESS_DATE_OUT_OF_BOUNDS,
        dateValidation.errors.join("; "),
        400,
      );
    }

    const requiredIds = requiredAccessIds ?? [];
    if (requiredIds.length > 0) {
      const existing = await findExistingAccessIdsInEvent(requiredIds, eventId);
      if (existing.length !== requiredIds.length) {
        throw new AppException(
          ErrorCodes.BAD_REQUEST,
          "One or more prerequisite access items not found or belong to different event",
          400,
        );
      }
    }

    const values: NewEventAccessValues = {
      eventId,
      type: data.type ?? "OTHER",
      name: data.name,
      description: data.description ?? null,
      location: data.location ?? null,
      startsAt: data.startsAt ?? null,
      endsAt: data.endsAt ?? null,
      price: data.price ?? 0,
      currency: data.currency ?? "TND",
      maxCapacity: data.maxCapacity ?? null,
      availableFrom: data.availableFrom ?? null,
      availableTo: data.availableTo ?? null,
      conditions: data.conditions ?? null,
      conditionLogic: data.conditionLogic ?? "AND",
      sortOrder: data.sortOrder ?? 0,
      active: data.active ?? true,
      groupLabel: data.groupLabel ?? null,
      allowCompanion: data.allowCompanion ?? false,
      includedInBase: data.includedInBase ?? false,
      companionPrice: data.companionPrice ?? 0,
    };

    return insertEventAccess(values, requiredIds);
  }

  /**
   * Update an access item. Opens a plain (read-committed) transaction ONLY when
   * maxCapacity changes or the item flips active true→false; otherwise no txn.
   */
  async updateEventAccess(
    id: string,
    input: UpdateEventAccessInput,
  ): Promise<EventAccessWithPrereqs> {
    const access = await getEventAccessForUpdate(id);
    if (!access) {
      throw new AppException(
        ErrorCodes.ACCESS_NOT_FOUND,
        "Access item not found",
        404,
      );
    }

    const { requiredAccessIds, ...data } = input;

    const mergedDates = {
      startsAt: data.startsAt !== undefined ? data.startsAt : access.startsAt,
      endsAt: data.endsAt !== undefined ? data.endsAt : access.endsAt,
      availableFrom:
        data.availableFrom !== undefined ? data.availableFrom : access.availableFrom,
      availableTo:
        data.availableTo !== undefined ? data.availableTo : access.availableTo,
    };

    const dateValidation = validateAccessDatesAgainstEvent(mergedDates, {
      startDate: access.event.startDate,
      endDate: access.event.endDate,
    });
    if (!dateValidation.valid) {
      throw new AppException(
        ErrorCodes.ACCESS_DATE_OUT_OF_BOUNDS,
        dateValidation.errors.join("; "),
        400,
      );
    }

    if (
      mergedDates.startsAt &&
      mergedDates.endsAt &&
      mergedDates.startsAt > mergedDates.endsAt
    ) {
      throw new AppException(
        ErrorCodes.VALIDATION_ERROR,
        "Access start time must be before end time",
        400,
      );
    }

    const updateData: Partial<NewEventAccessValues> = {};
    if (data.type !== undefined) updateData.type = data.type;
    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.location !== undefined) updateData.location = data.location;
    if (data.startsAt !== undefined) updateData.startsAt = data.startsAt;
    if (data.endsAt !== undefined) updateData.endsAt = data.endsAt;
    if (data.price !== undefined) updateData.price = data.price;
    if (data.currency !== undefined) updateData.currency = data.currency;
    if (data.maxCapacity !== undefined) updateData.maxCapacity = data.maxCapacity;
    if (data.availableFrom !== undefined)
      updateData.availableFrom = data.availableFrom;
    if (data.availableTo !== undefined) updateData.availableTo = data.availableTo;
    if (data.conditions !== undefined) {
      updateData.conditions = data.conditions === null ? null : data.conditions;
    }
    if (data.conditionLogic !== undefined)
      updateData.conditionLogic = data.conditionLogic;
    if (data.sortOrder !== undefined) updateData.sortOrder = data.sortOrder;
    if (data.active !== undefined) updateData.active = data.active;
    if (data.groupLabel !== undefined) updateData.groupLabel = data.groupLabel;
    if (data.allowCompanion !== undefined)
      updateData.allowCompanion = data.allowCompanion;
    if (data.includedInBase !== undefined)
      updateData.includedInBase = data.includedInBase;
    if (data.companionPrice !== undefined)
      updateData.companionPrice = data.companionPrice;

    if (requiredAccessIds !== undefined && requiredAccessIds.length > 0) {
      const existing = await findExistingAccessIdsInEvent(
        requiredAccessIds,
        access.eventId,
      );
      if (existing.length !== requiredAccessIds.length) {
        throw new AppException(
          ErrorCodes.BAD_REQUEST,
          "One or more prerequisite access items not found",
          400,
        );
      }
      const hasCycle = await this.detectCircularPrerequisites(
        access.eventId,
        id,
        requiredAccessIds,
      );
      if (hasCycle) {
        throw new AppException(
          ErrorCodes.ACCESS_CIRCULAR_DEPENDENCY,
          "Circular prerequisite dependency detected",
          400,
        );
      }
    }

    if (
      data.maxCapacity !== undefined &&
      data.maxCapacity !== null &&
      data.maxCapacity < access.paidCount
    ) {
      throw new AppException(
        ErrorCodes.ACCESS_CAPACITY_EXCEEDED,
        "Max capacity cannot be lower than settled paid access count",
        409,
        { paidCount: access.paidCount, requestedMaxCapacity: data.maxCapacity },
      );
    }

    const isCapacityChanging =
      data.maxCapacity !== undefined && data.maxCapacity !== access.maxCapacity;
    const isBeingDeactivated = data.active === false && access.active === true;

    if (isCapacityChanging || isBeingDeactivated) {
      return withTxn(async (tx) => {
        await updateEventAccessRow(id, updateData, tx);
        if (requiredAccessIds !== undefined) {
          await setAccessPrerequisites(id, requiredAccessIds, tx);
        }
        if (isBeingDeactivated) {
          await this.dropAccessFromUnsettledRegistrations(
            access.eventId,
            id,
            access.name,
            tx,
          );
        } else if (
          data.maxCapacity !== null &&
          access.paidCount === data.maxCapacity
        ) {
          await this.handleCapacityReached(access.eventId, [id], tx);
        }
        return (await getEventAccessWithPrereqs(id, tx)) as EventAccessWithPrereqs;
      });
    }

    await updateEventAccessRow(id, updateData);
    if (requiredAccessIds !== undefined) {
      await setAccessPrerequisites(id, requiredAccessIds);
    }
    return (await getEventAccessWithPrereqs(id)) as EventAccessWithPrereqs;
  }

  /** Delete an access item. NOT transactional (matches legacy non-atomic cleanup). */
  async deleteEventAccess(id: string): Promise<void> {
    const access = await getEventAccessByIdQuery(id);
    if (!access) {
      throw new AppException(
        ErrorCodes.ACCESS_NOT_FOUND,
        "Access item not found",
        404,
      );
    }

    const registrationCount = await countRegistrationsWithAccess(id);
    if (registrationCount > 0) {
      throw new AppException(
        ErrorCodes.ACCESS_HAS_REGISTRATIONS,
        "Cannot delete access item with existing registrations",
        409,
      );
    }

    const sponsorshipCount = await countActiveSponsorshipsWithAccess(id);
    if (sponsorshipCount > 0) {
      throw new AppException(
        ErrorCodes.ACCESS_HAS_SPONSORSHIPS,
        "Cannot delete access item referenced by active sponsorships",
        409,
      );
    }

    const dependents = await getAccessDependentIds(id);
    for (const dependentId of dependents) {
      await removePrerequisiteEdge(dependentId, id);
    }

    await deleteEventAccessById(id);
  }

  listEventAccess(
    eventId: string,
    options?: { active?: boolean; type?: string },
  ): Promise<EventAccessWithPrereqs[]> {
    return listEventAccessRows(eventId, options);
  }

  getEventAccessById(id: string): Promise<EventAccessWithPrereqs | null> {
    return getEventAccessByIdQuery(id);
  }

  getAccessClientId(id: string): Promise<string | null> {
    return getAccessClientIdQuery(id);
  }

  // =========================================================================
  // Grouping & validation
  // =========================================================================

  async getGroupedAccess(
    eventId: string,
    formData: Record<string, unknown>,
    selectedAccessIds: string[] = [],
    exec: DbExecutor = getDb(),
  ): Promise<GroupedAccessResponse> {
    const allAccess = await getActiveAccessForGrouping(eventId, exec);
    return groupAccess(allAccess, formData, selectedAccessIds, new Date());
  }

  async validateAccessSelections(
    eventId: string,
    selections: AccessSelection[],
    formData: Record<string, unknown>,
    existingAccessIds?: Set<string>,
    exec: DbExecutor = getDb(),
  ): Promise<{ valid: boolean; errors: string[] }> {
    const [selectedItems, includedAccesses] = await Promise.all([
      selections.length > 0
        ? getAccessByIdsForValidation(
            selections.map((s) => s.accessId),
            eventId,
            exec,
          )
        : Promise.resolve([]),
      getIncludedInBaseAccess(eventId, exec),
    ]);
    return validateSelections(
      selectedItems,
      includedAccesses,
      selections,
      formData,
      existingAccessIds,
      new Date(),
    );
  }

  // =========================================================================
  // Capacity counters (consumed by registrations/sponsorships, inside their txns)
  // =========================================================================

  /** Reporting counter bump — still refuses to exceed capacity relative to paidCount. */
  async incrementAccessRegisteredCountTx(
    accessId: string,
    quantity = 1,
    exec: DbExecutor = getDb(),
  ): Promise<void> {
    if (await casIncrementAccessRegisteredCount(accessId, quantity, exec)) return;

    const access = await getAccessCapacityInfo(accessId, exec);
    if (!access) {
      throw new AppException(ErrorCodes.ACCESS_NOT_FOUND, "Access not found", 404);
    }
    const remaining =
      access.maxCapacity === null
        ? null
        : Math.max(0, access.maxCapacity - access.paidCount);
    throw new AppException(
      ErrorCodes.ACCESS_CAPACITY_EXCEEDED,
      `${access.name} has insufficient capacity (${remaining ?? "unlimited"} spots remaining, requested ${quantity})`,
      409,
      { remaining, requested: quantity },
    );
  }

  async decrementAccessRegisteredCountTx(
    accessId: string,
    quantity = 1,
    exec: DbExecutor = getDb(),
  ): Promise<void> {
    if (await casDecrementAccessRegisteredCount(accessId, quantity, exec)) return;

    const access = await getAccessRegisteredCount(accessId, exec);
    if (!access) {
      throw new AppException(ErrorCodes.ACCESS_NOT_FOUND, "Access not found", 404);
    }
    throw new AppException(
      ErrorCodes.VALIDATION_ERROR,
      "Registered access count cannot be decremented below zero",
      409,
      { registeredCount: access.registeredCount, requested: quantity },
    );
  }

  /** Authoritative capacity gate: increment paid count atomically within capacity. */
  async incrementPaidCount(
    accessId: string,
    quantity = 1,
    exec: DbExecutor = getDb(),
  ): Promise<void> {
    if (await casIncrementAccessPaidCount(accessId, quantity, exec)) return;

    const access = await getAccessCapacityInfo(accessId, exec);
    if (!access) {
      throw new AppException(ErrorCodes.ACCESS_NOT_FOUND, "Access not found", 404);
    }
    const remaining =
      access.maxCapacity === null
        ? null
        : Math.max(0, access.maxCapacity - access.paidCount);
    throw new AppException(
      ErrorCodes.ACCESS_CAPACITY_EXCEEDED,
      `${access.name} has insufficient capacity (${remaining ?? "unlimited"} spots remaining, requested ${quantity})`,
      409,
      { remaining, requested: quantity },
    );
  }

  async decrementPaidCount(
    accessId: string,
    quantity = 1,
    exec: DbExecutor = getDb(),
  ): Promise<void> {
    if (await casDecrementAccessPaidCount(accessId, quantity, exec)) return;

    const access = await getAccessPaidCount(accessId, exec);
    if (!access) {
      throw new AppException(ErrorCodes.ACCESS_NOT_FOUND, "Access not found", 404);
    }
    throw new AppException(
      ErrorCodes.VALIDATION_ERROR,
      "Paid access count cannot be decremented below zero",
      409,
      { paidCount: access.paidCount, requested: quantity },
    );
  }

  /** Single integration point for registrations/sponsorships when payment state changes. */
  async syncPaidCountDelta(
    eventId: string,
    oldState: {
      status: string;
      priceBreakdown: unknown;
      coveredAccessIds?: Set<string>;
    },
    newState: {
      status: string;
      priceBreakdown: unknown;
      coveredAccessIds?: Set<string>;
    },
    exec: DbExecutor = getDb(),
  ): Promise<void> {
    const oldPaid = paidAccessQuantities(
      oldState.status,
      oldState.priceBreakdown,
      oldState.coveredAccessIds,
    );
    const newPaid = paidAccessQuantities(
      newState.status,
      newState.priceBreakdown,
      newState.coveredAccessIds,
    );
    const accessIds = new Set([...oldPaid.keys(), ...newPaid.keys()]);
    const incremented: string[] = [];

    for (const accessId of accessIds) {
      const delta = (newPaid.get(accessId) ?? 0) - (oldPaid.get(accessId) ?? 0);
      if (delta > 0) {
        await this.incrementPaidCount(accessId, delta, exec);
        incremented.push(accessId);
      } else if (delta < 0) {
        await this.decrementPaidCount(accessId, Math.abs(delta), exec);
      }
    }

    if (incremented.length > 0) {
      await this.handleCapacityReached(eventId, incremented, exec);
    }
  }

  /** Access ids covered by any sponsorship linked to a registration. */
  async getAlreadyCoveredAccessIds(
    registrationId: string,
    exec: DbExecutor = getDb(),
    excludeSponsorshipId?: string,
  ): Promise<Set<string>> {
    const ids = await getRegistrationCoveredAccessIds(
      registrationId,
      exec,
      excludeSponsorshipId,
    );
    return new Set(ids);
  }

  /** When paid count hits capacity, drop the access from unprotected unsettled regs. */
  async handleCapacityReached(
    eventId: string,
    accessIds: string[],
    exec: DbExecutor = getDb(),
  ): Promise<number> {
    if (accessIds.length === 0) return 0;

    const allAccesses = await getAccessCapacityRowsByIds(accessIds, exec);
    const atCapacity = allAccesses.filter(
      (a) => a.maxCapacity !== null && a.paidCount >= a.maxCapacity,
    );

    let totalAffected = 0;
    for (const access of atCapacity) {
      totalAffected += await this.dropAccessFromRegistrations(
        eventId,
        access.id,
        access.name,
        "capacity_reached",
        "ACCESS_CAPACITY_REACHED",
        exec,
      );
    }
    return totalAffected;
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * Strip an access item from all unsettled, unprotected registrations. Used when
   * an access is deactivated (reason "deactivated", audit action "ACCESS_DEACTIVATED").
   * Same recompute as capacity-reached, without the capacity gate.
   */
  private dropAccessFromUnsettledRegistrations(
    eventId: string,
    accessId: string,
    accessName: string,
    exec: DbExecutor,
  ): Promise<number> {
    return this.dropAccessFromRegistrations(
      eventId,
      accessId,
      accessName,
      "deactivated",
      "ACCESS_DEACTIVATED",
      exec,
    );
  }

  /**
   * Shared drop loop for capacity-reached and deactivation. Recomputes the
   * registration priceBreakdown JSON field-by-field (NOT via the pricing module),
   * decrements the reporting counter, writes a SYSTEM audit log, and enqueues a
   * PAYMENT_CONFIRMED email when the drop leaves the registration fully covered.
   */
  private async dropAccessFromRegistrations(
    eventId: string,
    accessId: string,
    accessName: string,
    reason: "capacity_reached" | "deactivated",
    auditAction: "ACCESS_CAPACITY_REACHED" | "ACCESS_DEACTIVATED",
    exec: DbExecutor,
  ): Promise<number> {
    const registrations = await getUnsettledRegistrationsWithAccess(
      eventId,
      accessId,
      exec,
    );

    let affected = 0;
    for (const reg of registrations) {
      const coveredIds = await getRegistrationCoveredAccessIds(reg.id, exec);
      if (coveredIds.includes(accessId)) continue;

      const breakdown = reg.priceBreakdown as RegistrationBreakdown;
      const droppedItem = breakdown.accessItems.find((a) => a.accessId === accessId);
      if (!droppedItem) continue;

      const newAccessItems = breakdown.accessItems.filter(
        (a) => a.accessId !== accessId,
      );
      const newAccessTotal = newAccessItems.reduce((sum, a) => sum + a.subtotal, 0);
      const newSubtotal = breakdown.calculatedBasePrice + newAccessTotal;
      const newSponsorshipTotal = Math.min(reg.sponsorshipAmount, newSubtotal);
      const newTotal = Math.max(0, newSubtotal - newSponsorshipTotal);
      const isNowFullyCovered =
        newSponsorshipTotal >= newSubtotal && newSubtotal > 0;

      const updatedBreakdown: RegistrationBreakdown = {
        ...breakdown,
        accessItems: newAccessItems,
        accessTotal: newAccessTotal,
        subtotal: newSubtotal,
        sponsorshipTotal: newSponsorshipTotal,
        total: newTotal,
        droppedAccessItems: [
          ...(breakdown.droppedAccessItems ?? []),
          { ...droppedItem, reason },
        ],
      };

      await updateRegistrationForAccessDrop(
        reg.id,
        {
          accessTypeIds: (reg.accessTypeIds ?? []).filter((x) => x !== accessId),
          droppedAccessIds: [...(reg.droppedAccessIds ?? []), accessId],
          priceBreakdown: updatedBreakdown as unknown as Record<string, unknown>,
          totalAmount: newTotal,
          accessAmount: newAccessTotal,
          sponsorshipAmount: newSponsorshipTotal,
          ...(isNowFullyCovered
            ? { paymentStatus: "SPONSORED" as const, paidAt: new Date() }
            : {}),
        },
        exec,
      );

      await this.decrementAccessRegisteredCountTx(
        accessId,
        droppedItem.quantity,
        exec,
      );

      await insertAuditLog(
        {
          entityType: "Registration",
          entityId: reg.id,
          action: auditAction,
          changes: {
            accessDropped: { old: accessName, new: reason },
            totalAmount: { old: reg.totalAmount, new: newTotal },
            priceDeducted: { old: 0, new: droppedItem.subtotal },
          },
          performedBy: "SYSTEM",
        },
        exec,
      );

      if (isNowFullyCovered) {
        await enqueueTriggeredEmailOutbox(
          exec,
          {
            trigger: "PAYMENT_CONFIRMED",
            eventId,
            registration: {
              id: reg.id,
              email: reg.email,
              firstName: reg.firstName,
              lastName: reg.lastName,
            },
          },
          `email:triggered:PAYMENT_CONFIRMED:${reg.id}`,
        );
      }

      affected++;
    }

    return affected;
  }

  /**
   * DFS cycle detection over the whole event's prerequisite graph, substituting
   * `newRequiredIds` as the edges for the item being updated.
   */
  private async detectCircularPrerequisites(
    eventId: string,
    accessId: string,
    newRequiredIds: string[],
  ): Promise<boolean> {
    const edges = await getEventPrereqEdges(eventId);
    const graph = new Map<string, string[]>();
    for (const { owner, required } of edges) {
      const deps = graph.get(owner) ?? [];
      deps.push(required);
      graph.set(owner, deps);
    }
    // The item being updated uses its proposed new prerequisites.
    graph.set(accessId, newRequiredIds);

    const visited = new Set<string>();
    const inStack = new Set<string>();

    const hasCycle = (nodeId: string): boolean => {
      if (inStack.has(nodeId)) return true;
      if (visited.has(nodeId)) return false;
      visited.add(nodeId);
      inStack.add(nodeId);
      for (const depId of graph.get(nodeId) ?? []) {
        if (hasCycle(depId)) return true;
      }
      inStack.delete(nodeId);
      return false;
    };

    return hasCycle(accessId);
  }
}
