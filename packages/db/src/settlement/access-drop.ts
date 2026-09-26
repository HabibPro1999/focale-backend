import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, sql } from "drizzle-orm";
import type { PriceBreakdown } from "@app/contracts";
import { createLogger, dropAccessItem, isFullySettled } from "@app/shared";
import { getDb, type DbExecutor } from "../client";
import { lockRegistrationForUpdate } from "../locks";
import { enqueueOutboxEvent, insertAuditLog } from "../outbox";
import type { OutboxHandlerMeta, OutboxHandlerResult } from "../outbox/types";
import {
  casDecrementAccessRegisteredCount,
  enqueueTriggeredEmailOutbox,
  getAccessCapacityRowsByIds,
} from "../queries/access";
import { findRegistrationUsagesForRecalc } from "../queries/registrations";
import { eventAccess, events } from "../schema/events-access";
import { auditLogs } from "../schema/outbox-audit";
import { registrations } from "../schema/registrations";
import { withLockingTxn } from "../txn";
import { emitSettlementEvents, settlementEventPair } from "./events";
import { AccessCapacityExceededError } from "./paid-access";
import { settleRegistrationTxn } from "./settle";

// Capacity drops (plan 2.8). When an access item fills up (its paid count
// reaches its capacity) or is deactivated, every unsettled registration that
// holds it without a sponsorship covering it loses the item. The transaction
// that filled or deactivated the item only enqueues an `access.capacityReached`
// outbox event (it never changes other registrations, ADR 0001 rule 3). The
// worker then drops the item from each registration in its own locking
// transaction, settling it through settleRegistrationTxn.

const logger = createLogger({ name: "db:access-drop" });

export const ACCESS_CAPACITY_REACHED_OUTBOX_TYPE = "access.capacityReached";

export type AccessDropReason = "capacity_reached" | "deactivated";

export interface AccessCapacityReachedPayload {
  eventId: string;
  accessId: string;
  reason: AccessDropReason;
}

/** Why one registration kept the item. */
export type AccessDropSkipReason =
  /** Gone, or no longer holds the item. */
  | "NOT_HELD"
  /** PAID, SPONSORED, WAIVED or REFUNDED. */
  | "SETTLED"
  /** A linked sponsorship covers the item. */
  | "COVERED"
  /** The item is no longer full (or no longer inactive). */
  | "NO_LONGER_APPLIES"
  /** The registration has paid more than it would owe without the item. */
  | "OVERPAID"
  /** Settling without the item needs a paid place another item no longer has. */
  | "CAPACITY_FULL";

export interface AccessDropSummary {
  accessId: string;
  reason: AccessDropReason;
  dropped: string[];
  skipped: Array<{ registrationId: string; reason: AccessDropSkipReason }>;
}

const DROP_AUDIT_ACTION: Record<AccessDropReason, string> = {
  capacity_reached: "ACCESS_CAPACITY_REACHED",
  deactivated: "ACCESS_DEACTIVATED",
};

/** Registration history action for a drop skipped because the registration is overpaid. */
export const ACCESS_DROP_SKIPPED_OVERPAID_AUDIT_ACTION = "ACCESS_DROP_SKIPPED_OVERPAID";

/** A drop skipped because the registration paid more than it would owe without the item. */
export interface OverpaidDropSkip {
  accessId: string;
  accessName: string;
  reason: AccessDropReason;
  paidAmount: number;
  /** Amount due with the item (gross minus sponsorship, now). */
  amountDue: number;
  /** Amount due the drop would have left, below `paidAmount`. */
  amountDueWithoutAccess: number;
}

/**
 * Enqueue the drop of these access items, in the caller's transaction. For
 * `capacity_reached` only the items whose paid count has reached their
 * capacity are enqueued. Returns the access ids enqueued, ascending.
 */
export async function enqueueAccessDrops(
  tx: DbExecutor,
  eventId: string,
  accessIds: readonly string[],
  reason: AccessDropReason,
): Promise<string[]> {
  let ids = [...new Set(accessIds)].sort();
  if (ids.length === 0) return [];
  if (reason === "capacity_reached") {
    const rows = await getAccessCapacityRowsByIds(ids, tx);
    const full = new Set(
      rows.filter((row) => row.maxCapacity !== null && row.paidCount >= row.maxCapacity).map((row) => row.id),
    );
    ids = ids.filter((id) => full.has(id));
  }
  for (const accessId of ids) {
    const payload: AccessCapacityReachedPayload = { eventId, accessId, reason };
    await enqueueOutboxEvent(tx, {
      type: ACCESS_CAPACITY_REACHED_OUTBOX_TYPE,
      aggregateType: "EventAccess",
      aggregateId: accessId,
      eventId,
      payload,
      maxAttempts: 10,
    });
  }
  return ids;
}

/** Whether the drop still applies to the item as it is now. */
async function dropStillApplies(tx: DbExecutor, accessId: string, reason: AccessDropReason) {
  const [row] = await tx
    .select({
      name: eventAccess.name,
      active: eventAccess.active,
      maxCapacity: eventAccess.maxCapacity,
      paidCount: eventAccess.paidCount,
    })
    .from(eventAccess)
    .where(eq(eventAccess.id, accessId))
    .limit(1);
  if (!row) return null;
  const applies =
    reason === "deactivated" ? !row.active : row.maxCapacity !== null && row.paidCount >= row.maxCapacity;
  return { name: row.name, applies };
}

/** Unsettled registrations of the event holding the item, ascending id (no lock). */
async function candidateRegistrationIds(db: DbExecutor, eventId: string, accessId: string): Promise<string[]> {
  const rows = await db
    .select({ id: registrations.id })
    .from(registrations)
    .where(
      and(
        eq(registrations.eventId, eventId),
        sql`${registrations.paymentStatus} NOT IN ('PAID', 'SPONSORED', 'WAIVED', 'REFUNDED')`,
        sql`${accessId}::text = ANY(${registrations.accessTypeIds})`,
      ),
    )
    .orderBy(asc(registrations.id));
  return rows.map((row) => row.id);
}

class SkipDrop extends Error {
  constructor(
    readonly reason: AccessDropSkipReason,
    readonly overpaid?: OverpaidDropSkip,
  ) {
    super(reason);
    this.name = "SkipDrop";
  }
}

/**
 * Drop the item from one registration in its own locking transaction: lock
 * it, re-check from the locked row (still unsettled, still holding the item,
 * not covered by a sponsorship, the item still full or inactive, not paid
 * more than it would owe), then settle it with the item removed from the
 * breakdown. Moves the registered count, audits the drop, enqueues the
 * PAYMENT_CONFIRMED email when it became fully settled, emits the realtime
 * events and enqueues further drops for items its new status filled.
 */
export async function dropAccessFromRegistration(
  registrationId: string,
  drop: AccessCapacityReachedPayload,
): Promise<"dropped" | AccessDropSkipReason> {
  try {
    await withLockingTxn(async (tx) => {
      if (!(await lockRegistrationForUpdate(tx, registrationId))) throw new SkipDrop("NOT_HELD");
      const [reg] = await tx
        .select({
          eventId: registrations.eventId,
          clientId: events.clientId,
          email: registrations.email,
          firstName: registrations.firstName,
          lastName: registrations.lastName,
          paymentStatus: registrations.paymentStatus,
          paidAmount: registrations.paidAmount,
          totalAmount: registrations.totalAmount,
          sponsorshipAmount: registrations.sponsorshipAmount,
          accessTypeIds: registrations.accessTypeIds,
          droppedAccessIds: registrations.droppedAccessIds,
          priceBreakdown: registrations.priceBreakdown,
        })
        .from(registrations)
        .innerJoin(events, eq(registrations.eventId, events.id))
        .where(eq(registrations.id, registrationId))
        .limit(1);
      if (!reg || reg.eventId !== drop.eventId) throw new SkipDrop("NOT_HELD");
      if (reg.paymentStatus === "REFUNDED" || isFullySettled(reg.paymentStatus)) throw new SkipDrop("SETTLED");
      const breakdown = reg.priceBreakdown as PriceBreakdown;
      const covered = (await findRegistrationUsagesForRecalc(registrationId, tx)).some((usage) =>
        usage.sponsorship.coveredAccessIds.includes(drop.accessId),
      );
      if (covered) throw new SkipDrop("COVERED");
      const result = dropAccessItem(breakdown, drop.accessId, reg.sponsorshipAmount, drop.reason);
      if (!result) throw new SkipDrop("NOT_HELD");
      const access = await dropStillApplies(tx, drop.accessId, drop.reason);
      if (!access?.applies) throw new SkipDrop("NO_LONGER_APPLIES");

      const settled = await settleRegistrationTxn(tx, registrationId, {
        priceBreakdown: result.breakdown as PriceBreakdown,
        totalAmount: result.gross,
        decide: ({ before, net }) => {
          if (before.paidAmount > net) {
            throw new SkipDrop("OVERPAID", {
              accessId: drop.accessId,
              accessName: access.name,
              reason: drop.reason,
              paidAmount: before.paidAmount,
              amountDue: Math.max(0, before.totalAmount - before.sponsorshipAmount),
              amountDueWithoutAccess: net,
            });
          }
          return undefined;
        },
        fields: {
          accessTypeIds: (reg.accessTypeIds ?? []).filter((id) => id !== drop.accessId),
          droppedAccessIds: [...(reg.droppedAccessIds ?? []), drop.accessId],
        },
      });
      if (!settled) throw new SkipDrop("NOT_HELD");

      // The reporting counter follows the item; a counter already at 0 is logged, not fatal.
      const quantity = result.dropped.quantity;
      if (!(await casDecrementAccessRegisteredCount(drop.accessId, quantity, tx))) {
        logger.warn({ accessId: drop.accessId, registrationId, quantity }, "registered count already below the dropped quantity");
      }

      const { before, after } = settled;
      const changes: Record<string, { old: unknown; new: unknown }> = {
        accessDropped: { old: access.name, new: drop.reason },
        totalAmount: { old: before.totalAmount, new: after.totalAmount },
        priceDeducted: { old: 0, new: result.dropped.subtotal },
      };
      if (before.paymentStatus !== after.paymentStatus) {
        changes.paymentStatus = { old: before.paymentStatus, new: after.paymentStatus };
      }
      await insertAuditLog(
        {
          entityType: "Registration",
          entityId: registrationId,
          action: DROP_AUDIT_ACTION[drop.reason],
          changes,
          performedBy: "SYSTEM",
        },
        tx,
      );
      const becameSettled = isFullySettled(after.paymentStatus) && !isFullySettled(before.paymentStatus);
      if (becameSettled) {
        await enqueueTriggeredEmailOutbox(
          tx,
          {
            trigger: "PAYMENT_CONFIRMED",
            eventId: drop.eventId,
            registration: { id: registrationId, email: reg.email, firstName: reg.firstName, lastName: reg.lastName },
          },
          `email:triggered:PAYMENT_CONFIRMED:${registrationId}`,
        );
      }
      await enqueueAccessDrops(tx, drop.eventId, settled.paidAccess.incremented, "capacity_reached");
      await emitSettlementEvents(
        tx,
        settlementEventPair({
          id: registrationId,
          eventId: drop.eventId,
          clientId: reg.clientId,
          oldStatus: before.paymentStatus,
          newStatus: after.paymentStatus,
          emitCountsChanged: true,
          accessIds: [
            ...new Set([drop.accessId, ...settled.paidAccess.incremented, ...settled.paidAccess.decremented]),
          ].sort(),
        }),
      );
    });
    return "dropped";
  } catch (err) {
    if (err instanceof SkipDrop) {
      if (err.overpaid) await recordOverpaidDropSkip(registrationId, err.overpaid);
      return err.reason;
    }
    if (err instanceof AccessCapacityExceededError) return "CAPACITY_FULL";
    throw err;
  }
}

function overpaidSkipChanges(skip: OverpaidDropSkip): Record<string, { old: unknown; new: unknown }> {
  return {
    accessKept: { old: skip.accessName, new: skip.reason },
    accessId: { old: null, new: skip.accessId },
    paidAmount: { old: null, new: skip.paidAmount },
    amountDue: { old: null, new: skip.amountDue },
    amountDueWithoutAccess: { old: null, new: skip.amountDueWithoutAccess },
  };
}

/**
 * An overpaid registration keeps the item (no automatic overpayment); an
 * admin handles it. Every skip is logged at warn, and recorded on the
 * registration's history (`ACCESS_DROP_SKIPPED_OVERPAID`, by SYSTEM) in its
 * own transaction, since the drop's transaction rolled back. An entry
 * identical to one already recorded (a redelivered event, the same access
 * filling again) is not repeated. Returns whether an entry was written.
 */
export async function recordOverpaidDropSkip(registrationId: string, skip: OverpaidDropSkip): Promise<boolean> {
  logger.warn({ registrationId, ...skip }, "access drop skipped: the registration paid more than it would owe without the item");
  const changes = overpaidSkipChanges(skip);
  return withLockingTxn(async (tx) => {
    if (!(await lockRegistrationForUpdate(tx, registrationId))) return false;
    const recorded = await tx
      .select({ changes: auditLogs.changes })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, "Registration"),
          eq(auditLogs.entityId, registrationId),
          eq(auditLogs.action, ACCESS_DROP_SKIPPED_OVERPAID_AUDIT_ACTION),
        ),
      );
    if (recorded.some((row) => isDeepStrictEqual(row.changes, changes))) return false;
    await insertAuditLog(
      {
        entityType: "Registration",
        entityId: registrationId,
        action: ACCESS_DROP_SKIPPED_OVERPAID_AUDIT_ACTION,
        changes,
        performedBy: "SYSTEM",
      },
      tx,
    );
    return true;
  });
}

/**
 * Drop an access item from every unsettled registration holding it, one
 * registration per transaction. Registrations already handled no longer
 * hold the item, so running it again only finishes what is left. Stops
 * (throwing) when `signal` aborts; the outbox then retries the event.
 */
export async function dropAccessFromUnsettledRegistrations(
  drop: AccessCapacityReachedPayload,
  options: { signal?: AbortSignal; db?: DbExecutor } = {},
): Promise<AccessDropSummary> {
  const summary: AccessDropSummary = { accessId: drop.accessId, reason: drop.reason, dropped: [], skipped: [] };
  const db = options.db ?? getDb();
  const access = await dropStillApplies(db, drop.accessId, drop.reason);
  if (!access?.applies) return summary;
  for (const registrationId of await candidateRegistrationIds(db, drop.eventId, drop.accessId)) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("access drop aborted");
    const outcome = await dropAccessFromRegistration(registrationId, drop);
    if (outcome === "dropped") summary.dropped.push(registrationId);
    else summary.skipped.push({ registrationId, reason: outcome });
    if (outcome === "NO_LONGER_APPLIES") break;
  }
  return summary;
}

function parsePayload(payload: unknown): AccessCapacityReachedPayload | null {
  const p = payload as Partial<AccessCapacityReachedPayload> | null;
  if (
    !p ||
    typeof p.eventId !== "string" ||
    typeof p.accessId !== "string" ||
    (p.reason !== "capacity_reached" && p.reason !== "deactivated")
  ) {
    return null;
  }
  return { eventId: p.eventId, accessId: p.accessId, reason: p.reason };
}

/** Worker outbox handler for `access.capacityReached`. A malformed payload is skipped. */
export async function handleAccessCapacityReachedOutbox(
  payload: unknown,
  meta?: OutboxHandlerMeta,
): Promise<OutboxHandlerResult> {
  const drop = parsePayload(payload);
  if (!drop) {
    logger.warn({ payload }, "access.capacityReached skipped: malformed payload");
    return "skipped";
  }
  const summary = await dropAccessFromUnsettledRegistrations(drop, { signal: meta?.signal });
  if (summary.dropped.length > 0 || summary.skipped.length > 0) {
    logger.info(
      {
        accessId: drop.accessId,
        reason: drop.reason,
        dropped: summary.dropped.length,
        skipped: summary.skipped.filter((s) => s.reason !== "SETTLED" && s.reason !== "COVERED"),
      },
      "access drop processed",
    );
  }
  return "processed";
}
