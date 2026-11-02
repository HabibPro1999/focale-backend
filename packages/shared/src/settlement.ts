import type {
  AccessDropReason,
  AccessLineItem,
  DroppedAccessItem,
  PriceBreakdown,
} from "@app/contracts";
import { isFullySettled, type SettlementStatus } from "./payment-status";
import { sumMoney, subtractMoney, withBreakdownMoney } from "./money";

// Legacy fields remain major units. Arithmetic uses exact integer units via
// money.ts, and additive snapshots expose currency-specific minor units.
//
// Vocabulary:
// - gross: `total_amount`, the price after pricing rules and before any
//   sponsorship (`priceBreakdown.subtotal`);
// - sponsorship: the sponsorship amount applied, never more than gross
//   (`sponsorship_amount`, `priceBreakdown.sponsorshipTotal`);
// - net: what the registrant owes in total, gross minus sponsorship
//   (`priceBreakdown.total`);
// - paid: `paid_amount`; due: what is still owed, net minus paid, at least 0.
//
// These functions are pure. The settlement writer (plan item 2.6) is the only
// code that writes their results to the database.

/**
 * totalAmount is gross (after pricing rules, before sponsorship).
 * sponsorshipAmount is deducted here exactly once; priceBreakdown.total is net.
 */
export function calculateSettlement(reg: {
  totalAmount: number;
  paidAmount: number;
  sponsorshipAmount: number;
}) {
  const covered = sumMoney(reg.paidAmount, reg.sponsorshipAmount);
  const amountDue = Math.max(0, subtractMoney(reg.totalAmount, covered));
  return {
    amountDue,
    netAmount: Math.max(0, subtractMoney(reg.totalAmount, reg.sponsorshipAmount)),
    isSettled: amountDue === 0 && reg.totalAmount >= 0,
    isPartiallyPaid: covered > 0 && amountDue > 0,
  };
}

// ============================================================================
// Payment status derivation
// ============================================================================

/**
 * Statuses the settlement never changes by itself: REFUNDED and WAIVED are
 * admin decisions, PAID means paid in full, and VERIFYING only leaves through
 * admin review of the payment proof.
 */
export const STICKY_SETTLEMENT_STATUSES = ["REFUNDED", "WAIVED", "PAID", "VERIFYING"] as const;

export function isStickySettlementStatus(status: SettlementStatus): boolean {
  return (STICKY_SETTLEMENT_STATUSES as readonly SettlementStatus[]).includes(status);
}

/**
 * Status changes deriveSettlement may make on its own (current → allowed
 * next). Sticky statuses have none. Admin and registrant actions have their
 * own, stricter rules; this table is only what a recomputation may do after
 * amounts change (a sponsorship linked or removed, an item dropped, a price
 * edit).
 */
export const AUTO_TRANSITIONS: Readonly<Record<SettlementStatus, readonly SettlementStatus[]>> = {
  PENDING: ["PARTIAL", "PAID", "SPONSORED"],
  PARTIAL: ["PENDING", "PAID", "SPONSORED"],
  SPONSORED: ["PENDING", "PARTIAL", "PAID"],
  VERIFYING: [],
  PAID: [],
  WAIVED: [],
  REFUNDED: [],
};

export interface SettlementInput {
  /** total_amount: after pricing rules, before sponsorship. */
  gross: number;
  /** Sponsorship amount to apply; anything above gross is ignored. */
  sponsorship: number;
  /** paid_amount. */
  paid: number;
  currentStatus: SettlementStatus;
  paidAt: Date | null;
  now: Date;
}

export interface DerivedSettlement {
  status: SettlementStatus;
  paidAt: Date | null;
  gross: number;
  /** The sponsorship applied: min(sponsorship, gross). */
  sponsorship: number;
  /** gross − sponsorship. */
  net: number;
  /** max(0, net − paid). */
  due: number;
}

function assertAmount(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value !== Number(value.toFixed(4))) {
    throw new RangeError(`${name} must be a non-negative exact money amount, got ${value}`);
  }
  sumMoney(value);
}

/**
 * The settlement a registration's amounts imply.
 *
 * - REFUNDED, WAIVED, PAID and VERIFYING are sticky: status and paidAt stay.
 * - Otherwise the first that holds: SPONSORED (the sponsorship covers a
 *   non-zero gross), PAID (something was paid and nothing is due), PARTIAL
 *   (something is covered and something is due), PENDING.
 * - For a derived status, paidAt is null exactly for PENDING and PARTIAL; PAID
 *   and SPONSORED keep an existing paidAt, else take `now`.
 *
 * Deriving again from the result gives the same result. This is the legacy
 * linked-sponsorship recompute, which the settlement writer (2.6) will use
 * for every money change.
 */
export function deriveSettlement(input: SettlementInput): DerivedSettlement {
  assertAmount("gross", input.gross);
  assertAmount("sponsorship", input.sponsorship);
  assertAmount("paid", input.paid);

  const gross = input.gross;
  const sponsorship = Math.min(input.sponsorship, gross);
  const net = subtractMoney(gross, sponsorship);
  const due = Math.max(0, subtractMoney(net, input.paid));
  const amounts = { gross, sponsorship, net, due };

  if (isStickySettlementStatus(input.currentStatus)) {
    return { status: input.currentStatus, paidAt: input.paidAt, ...amounts };
  }

  let status: SettlementStatus;
  if (gross > 0 && sponsorship >= gross) status = "SPONSORED";
  else if (input.paid > 0 && due === 0) status = "PAID";
  else if (sumMoney(input.paid, sponsorship) > 0 && due > 0) status = "PARTIAL";
  else status = "PENDING";

  const paidAt = status === "PAID" || status === "SPONSORED" ? (input.paidAt ?? input.now) : null;
  return { status, paidAt, ...amounts };
}

// ============================================================================
// Price breakdown (the registrations.price_breakdown JSON, `PriceBreakdown`)
// ============================================================================

/**
 * The breakdown with its net fields set for a sponsorship amount:
 * sponsorshipTotal = min(sponsorship, subtotal), total = subtotal −
 * sponsorshipTotal. Every other field is kept.
 */
export function netBreakdown<T extends Pick<PriceBreakdown, "subtotal">>(
  breakdown: T,
  sponsorship: number,
): T & Pick<PriceBreakdown, "sponsorshipTotal" | "total"> {
  const sponsorshipTotal = Math.min(sponsorship, breakdown.subtotal);
  const next = {
    ...breakdown,
    sponsorshipTotal,
    total: Math.max(0, subtractMoney(breakdown.subtotal, sponsorshipTotal)),
  };
  // Partial breakdowns are used by older callers; only full snapshots carry money.
  if ("money" in next && "currency" in next && "basePrice" in next && "calculatedBasePrice" in next && "accessTotal" in next) {
    return withBreakdownMoney(next as typeof next & PriceBreakdown);
  }
  return next;
}

/** The parts of a breakdown dropping an access item reads. */
export type DroppableBreakdown = Pick<
  PriceBreakdown,
  "calculatedBasePrice" | "accessItems" | "droppedAccessItems" | "optionModifiersTotal"
>;

export interface DroppedAccessItemResult<T extends DroppableBreakdown> {
  breakdown: T &
    Pick<PriceBreakdown, "accessTotal" | "subtotal" | "sponsorshipTotal" | "total"> & {
      droppedAccessItems: DroppedAccessItem[];
    };
  /** The dropped line item (the first with this access id). */
  dropped: AccessLineItem;
  /** New total_amount: calculatedBasePrice + remaining access items. */
  gross: number;
  /** New access_amount. */
  accessAmount: number;
  /** New sponsorship_amount: min(sponsorship, gross). */
  sponsorship: number;
}

/**
 * Remove an access item from a breakdown (capacity reached, item
 * deactivated), as the access service does today: the item's rows leave
 * accessItems, the first is recorded in droppedAccessItems with `reason`,
 * and accessTotal, subtotal and the net fields are recomputed from the
 * remaining items with the sponsorship capped at the new subtotal. Null when
 * the breakdown has no such item.
 */
export function dropAccessItem<T extends DroppableBreakdown>(
  breakdown: T,
  accessId: string,
  sponsorship: number,
  reason: AccessDropReason,
): DroppedAccessItemResult<T> | null {
  const dropped = breakdown.accessItems.find((item) => item.accessId === accessId);
  if (!dropped) return null;
  const accessItems = breakdown.accessItems.filter((item) => item.accessId !== accessId);
  const accessTotal = sumMoney(...accessItems.map((item) => item.subtotal));
  const subtotal = Math.max(0, sumMoney(breakdown.calculatedBasePrice, accessTotal, breakdown.optionModifiersTotal ?? 0));
  const next = netBreakdown(
    {
      ...breakdown,
      accessItems,
      accessTotal,
      subtotal,
      droppedAccessItems: [...(breakdown.droppedAccessItems ?? []), { ...dropped, reason }],
    },
    Math.min(sponsorship, Math.max(0, sumMoney(breakdown.calculatedBasePrice, accessTotal))),
  );
  return {
    breakdown: next,
    dropped,
    gross: subtotal,
    accessAmount: accessTotal,
    sponsorship: next.sponsorshipTotal,
  };
}

/** The part of a breakdown paid capacity is counted from. */
export interface PaidAccessBreakdown {
  accessItems: ReadonlyArray<Pick<AccessLineItem, "accessId" | "quantity">>;
}

// ============================================================================
// Access capacity and discounts
// ============================================================================

/**
 * Access quantities a registration holds in paid capacity: every item when
 * fully settled, only sponsorship-covered items when PARTIAL or VERIFYING,
 * none otherwise. Reviewing proof for the balance keeps sponsored seats.
 * Paid-count deltas are the difference between two of these.
 */
export function paidAccessQuantities(
  status: string,
  priceBreakdown: PaidAccessBreakdown,
  coveredAccessIds: ReadonlySet<string> = new Set<string>(),
): Map<string, number> {
  const quantities = new Map<string, number>();
  const fullySettled = isFullySettled(status);
  if (!fullySettled && status !== "PARTIAL" && status !== "VERIFYING") {
    return quantities;
  }
  // A stored breakdown read under JSONB_VALIDATION=warn may lack its items.
  for (const item of priceBreakdown.accessItems ?? []) {
    if (fullySettled || coveredAccessIds.has(item.accessId)) {
      quantities.set(item.accessId, (quantities.get(item.accessId) ?? 0) + item.quantity);
    }
  }
  return quantities;
}

/** discount_amount: the absolute sum of the applied pricing rules' negative effects. */
export function calculateDiscountAmount(appliedRules: ReadonlyArray<{ effect: number }>): number {
  return Math.abs(sumMoney(...appliedRules.filter((rule) => rule.effect < 0).map((rule) => rule.effect)));
}
