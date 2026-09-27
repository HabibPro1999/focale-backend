import { Injectable } from "@nestjs/common";
import { ErrorCodes, buildFieldOptionIndex, findInvalidOptionConditions } from "@app/contracts";
import { isFullySettled, isFullySponsored } from "@app/shared";
import type {
  CreateEventAccessInput,
  UpdateEventAccessInput,
  AccessSelection,
  GroupedAccessResponse,
} from "@app/contracts";
import {
  getDb,
  findRegistrationFormSchema,
  withTxn,
  type DbExecutor,
  type EventAccessWithPrereqs,
  type NewEventAccessValues,
  getEventDatesForAccess,
  getEventAccessById as getEventAccessByIdQuery,
  getEventAccessForUpdate,
  listEventAccessRows,
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
  getAccessCounters,
  getAccessCapacityRowsByIds,
  getUnsettledRegistrationsWithAccess,
  getRegistrationCoveredAccessIds,
  updateRegistrationRow,
  insertAuditLog,
  enqueueTriggeredEmailOutbox,
} from "@app/db";
import { badRequest, notFound, conflict } from "../../core/app-exception";
import { quantitiesByAccess, quantityDeltas } from "./access-quantities";
import { groupAccess } from "./access-grouping";
import { validateSelections } from "./access-validation";

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

  const fields = [
    ["startsAt", "L'heure de début"],
    ["endsAt", "L'heure de fin"],
    ["availableFrom", "La date de disponibilité"],
    ["availableTo", "La date limite"],
  ] as const;
  for (const [field, label] of fields) {
    const date = accessDates[field];
    if (date && (date < startDate || date > endDate)) {
      errors.push(`${label} doit être dans la plage de l'événement (${range})`);
    }
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
  const fullySettled = isFullySettled(status);
  if (!fullySettled && status !== "PARTIAL") return new Map<string, number>();
  const breakdown = priceBreakdown as RegistrationBreakdown;
  return quantitiesByAccess((breakdown.accessItems ?? []).filter(
    (item) => fullySettled || coveredAccessIds.has(item.accessId),
  ));
}

@Injectable()
export class AccessService {
  private async assertValidOptionConditions(
    eventId: string,
    accessName: string,
    conditions: CreateEventAccessInput["conditions"],
    accessId?: string,
  ): Promise<void> {
    if (!conditions?.length) return;
    const form = await findRegistrationFormSchema(eventId);
    if (!form) return;
    const bad = findInvalidOptionConditions(
      conditions,
      buildFieldOptionIndex(form.schema),
    );
    if (!bad.length) return;
    const f = bad[0];
    throw badRequest(`Access item "${accessName}": value "${String(f.value)}" for field "${f.fieldLabel}" is not one of the field's option ids (e.g. ${f.exampleOptionIds.map((id) => `"${id}"`).join(", ")}). Pick the option in the rule editor.`, { code: ErrorCodes.ACCESS_CONDITION_INVALID_OPTION, details: { accessId, accessName, ...f } });
  }

  async assertAccessSelectionRequirement(
    eventId: string,
    formData: Record<string, unknown>,
    selections: AccessSelection[],
    schema: unknown,
    db?: DbExecutor,
  ): Promise<void> {
    const settings = (schema as { settings?: { accessSelectionRequired?: boolean } } | null)?.settings;
    if (settings?.accessSelectionRequired !== true) return;
    const ids = selections.filter((s) => s.quantity > 0).map((s) => s.accessId);
    if (ids.length) {
      const items = await getAccessByIdsForValidation(ids, eventId, db);
      if (items.some((item) => !item.includedInBase)) return;
    }
    const grouped = await this.getGroupedAccess(eventId, formData, ids, db);
    const items = [
      ...grouped.groups.flatMap((g) => g.slots.flatMap((s) => s.items)),
      ...(grouped.addonGroup?.slots.flatMap((s) => s.items) ?? []),
    ] as Array<{ includedInBase: boolean; isFull: boolean }>;
    if (items.some((item) => !item.includedInBase && !item.isFull)) {
      throw badRequest("Veuillez sélectionner au moins une option", { code: ErrorCodes.ACCESS_SELECTION_REQUIRED });
    }
  }

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
      throw notFound("Event not found");
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
      throw badRequest(dateValidation.errors.join("; "), { code: ErrorCodes.ACCESS_DATE_OUT_OF_BOUNDS });
    }

    const requiredIds = requiredAccessIds ?? [];
    if (requiredIds.length > 0) {
      const existing = await findExistingAccessIdsInEvent(requiredIds, eventId);
      if (existing.length !== requiredIds.length) {
        throw badRequest("One or more prerequisite access items not found or belong to different event", { code: ErrorCodes.BAD_REQUEST });
      }
    }

    await this.assertValidOptionConditions(eventId, data.name, data.conditions);

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
      throw notFound("Access item not found", { code: ErrorCodes.ACCESS_NOT_FOUND });
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
      throw badRequest(dateValidation.errors.join("; "), { code: ErrorCodes.ACCESS_DATE_OUT_OF_BOUNDS });
    }

    if (
      mergedDates.startsAt &&
      mergedDates.endsAt &&
      mergedDates.startsAt > mergedDates.endsAt
    ) {
      throw badRequest("Access start time must be before end time");
    }

    await this.assertValidOptionConditions(
      access.eventId,
      data.name ?? access.name,
      data.conditions,
      id,
    );

    const updateData: Partial<NewEventAccessValues> = Object.fromEntries(
      Object.entries(data).filter(([, value]) => value !== undefined),
    );

    if (requiredAccessIds !== undefined && requiredAccessIds.length > 0) {
      const existing = await findExistingAccessIdsInEvent(
        requiredAccessIds,
        access.eventId,
      );
      if (existing.length !== requiredAccessIds.length) {
        throw badRequest("One or more prerequisite access items not found", { code: ErrorCodes.BAD_REQUEST });
      }
      const hasCycle = await this.detectCircularPrerequisites(
        access.eventId,
        id,
        requiredAccessIds,
      );
      if (hasCycle) {
        throw badRequest("Circular prerequisite dependency detected", { code: ErrorCodes.ACCESS_CIRCULAR_DEPENDENCY });
      }
    }

    if (
      data.maxCapacity !== undefined &&
      data.maxCapacity !== null &&
      data.maxCapacity < access.paidCount
    ) {
      throw conflict("Max capacity cannot be lower than settled paid access count", { code: ErrorCodes.ACCESS_CAPACITY_EXCEEDED, details: { paidCount: access.paidCount, requestedMaxCapacity: data.maxCapacity } });
    }

    const isCapacityChanging =
      data.maxCapacity !== undefined && data.maxCapacity !== access.maxCapacity;
    const isBeingDeactivated = data.active === false && access.active === true;

    const apply = async (exec: DbExecutor): Promise<EventAccessWithPrereqs> => {
      await updateEventAccessRow(id, updateData, exec);
      if (requiredAccessIds !== undefined) {
        await setAccessPrerequisites(id, requiredAccessIds, exec);
      }
      if (isBeingDeactivated) {
        await this.dropAccessFromRegistrations(access.eventId, id, access.name, "deactivated", "ACCESS_DEACTIVATED", exec);
      } else if (isCapacityChanging && data.maxCapacity !== null && access.paidCount === data.maxCapacity) {
        await this.handleCapacityReached(access.eventId, [id], exec);
      }
      // Keep the existing nullable reload behavior; concurrent deletion is not a new 404.
      return (await getEventAccessByIdQuery(id, exec)) as EventAccessWithPrereqs;
    };
    return isCapacityChanging || isBeingDeactivated ? withTxn(apply) : apply(getDb());
  }

  /** Delete an access item. NOT transactional (matches legacy non-atomic cleanup). */
  async deleteEventAccess(id: string): Promise<void> {
    const access = await getEventAccessByIdQuery(id);
    if (!access) {
      throw notFound("Access item not found", { code: ErrorCodes.ACCESS_NOT_FOUND });
    }

    const registrationCount = await countRegistrationsWithAccess(id);
    if (registrationCount > 0) {
      throw conflict("Cannot delete access item with existing registrations", { code: ErrorCodes.ACCESS_HAS_REGISTRATIONS });
    }

    const sponsorshipCount = await countActiveSponsorshipsWithAccess(id);
    if (sponsorshipCount > 0) {
      throw conflict("Cannot delete access item referenced by active sponsorships", { code: ErrorCodes.ACCESS_HAS_SPONSORSHIPS });
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

  async assertAccessSelectionsValid(...args: Parameters<AccessService["validateAccessSelections"]>): Promise<void> {
    const result = await this.validateAccessSelections(...args);
    if (!result.valid) {
      throw badRequest(`Invalid access selections: ${result.errors.join(", ")}`, { code: ErrorCodes.BAD_REQUEST, details: { errors: result.errors } });
    }
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

    await this.throwInsufficientCapacity(accessId, quantity, exec);
  }

  async decrementAccessRegisteredCountTx(
    accessId: string,
    quantity = 1,
    exec: DbExecutor = getDb(),
  ): Promise<void> {
    if (await casDecrementAccessRegisteredCount(accessId, quantity, exec)) return;

    await this.throwCounterUnderflow(accessId, quantity, "registeredCount", "Registered access count cannot be decremented below zero", exec);
  }

  /** Authoritative capacity gate: increment paid count atomically within capacity. */
  async incrementPaidCount(
    accessId: string,
    quantity = 1,
    exec: DbExecutor = getDb(),
  ): Promise<void> {
    if (await casIncrementAccessPaidCount(accessId, quantity, exec)) return;

    await this.throwInsufficientCapacity(accessId, quantity, exec);
  }

  async decrementPaidCount(
    accessId: string,
    quantity = 1,
    exec: DbExecutor = getDb(),
  ): Promise<void> {
    if (await casDecrementAccessPaidCount(accessId, quantity, exec)) return;

    await this.throwCounterUnderflow(accessId, quantity, "paidCount", "Paid access count cannot be decremented below zero", exec);
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
    const incremented: string[] = [];

    for (const { accessId, delta } of quantityDeltas(oldPaid, newPaid)) {
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

  private async throwInsufficientCapacity(accessId: string, quantity: number, exec: DbExecutor): Promise<never> {
    const access = await getAccessCounters(accessId, exec);
    if (!access) throw notFound("Access not found", { code: ErrorCodes.ACCESS_NOT_FOUND });
    const remaining = access.maxCapacity === null ? null : Math.max(0, access.maxCapacity - access.paidCount);
    throw conflict(`${access.name} has insufficient capacity (${remaining ?? "unlimited"} spots remaining, requested ${quantity})`, { code: ErrorCodes.ACCESS_CAPACITY_EXCEEDED, details: { remaining, requested: quantity } });
  }

  private async throwCounterUnderflow(accessId: string, quantity: number, field: "registeredCount" | "paidCount", message: string, exec: DbExecutor): Promise<never> {
    const access = await getAccessCounters(accessId, exec);
    if (!access) throw notFound("Access not found", { code: ErrorCodes.ACCESS_NOT_FOUND });
    throw conflict(message, { code: ErrorCodes.VALIDATION_ERROR, details: { [field]: access[field], requested: quantity } });
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
      const droppedItem = breakdown.accessItems.find(
        (a) => a.accessId === accessId,
      );
      if (!droppedItem) continue;

      const newAccessItems = breakdown.accessItems.filter(
        (a) => a.accessId !== accessId,
      );
      const newAccessTotal = newAccessItems.reduce(
        (sum, a) => sum + a.subtotal,
        0,
      );
      const newSubtotal = breakdown.calculatedBasePrice + newAccessTotal;
      const newSponsorshipTotal = Math.min(reg.sponsorshipAmount, newSubtotal);
      const newTotal = Math.max(0, newSubtotal - newSponsorshipTotal);
      const isNowFullyCovered =
        isFullySponsored({ sponsorshipAmount: newSponsorshipTotal, totalAmount: newSubtotal });

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

      await updateRegistrationRow(
        reg.id,
        {
          accessTypeIds: (reg.accessTypeIds ?? []).filter(
            (x) => x !== accessId,
          ),
          droppedAccessIds: [...(reg.droppedAccessIds ?? []), accessId],
          priceBreakdown: updatedBreakdown as unknown as Record<string, unknown>,
          totalAmount: newSubtotal,
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
            totalAmount: { old: reg.totalAmount, new: newSubtotal },
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
