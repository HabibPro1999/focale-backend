import { and, eq } from "drizzle-orm";
import type { PriceBreakdown } from "@app/contracts";
import { calculateDiscountAmount } from "@app/shared";
import type { DbExecutor } from "../client";
import { registrations } from "../schema/registrations";
import { isTransactionExecutor } from "../txn";
import type { RegistrationPatch } from "../queries/registrations";

/**
 * The registration columns only the settlement writer may write: the money
 * amounts, the payment status and its date, and the price breakdown JSON
 * with the three amounts derived from it.
 */
export const SETTLEMENT_COLUMNS = [
  "paymentStatus",
  "paidAt",
  "paidAmount",
  "totalAmount",
  "sponsorshipAmount",
  "priceBreakdown",
  "baseAmount",
  "accessAmount",
  "discountAmount",
] as const;

export type SettlementColumn = (typeof SETTLEMENT_COLUMNS)[number];

/** Registration columns other writers may set: everything but the money. */
export type RegistrationFieldsPatch = Omit<RegistrationPatch, SettlementColumn>;

export type RegistrationPaymentStatus = NonNullable<RegistrationPatch["paymentStatus"]>;

/** The money state a write sets. Omitted columns keep their stored value. */
export interface RegistrationSettlementWrite {
  paymentStatus?: RegistrationPaymentStatus;
  paidAt?: Date | null;
  paidAmount?: number;
  /** Gross: after pricing rules, before sponsorship. */
  totalAmount?: number;
  sponsorshipAmount?: number;
  /** Also sets base_amount, access_amount and discount_amount from it. */
  priceBreakdown?: PriceBreakdown;
}

export interface ApplyRegistrationSettlementInput {
  registrationId: string;
  settlement: RegistrationSettlementWrite;
  /** Other columns written in the same UPDATE. Money columns are refused. */
  fields?: RegistrationFieldsPatch;
  /**
   * Compare-and-swap on updated_at: when the row changed since this value was
   * read, nothing is written and the writer returns false.
   */
  expectedUpdatedAt?: Date;
}

/** A write would leave the registration's money state inconsistent; the transaction must roll back. */
export class SettlementInvariantError extends Error {
  constructor(
    readonly registrationId: string,
    readonly violations: string[],
  ) {
    super(`Registration ${registrationId} settlement invariant violated: ${violations.join("; ")}`);
    this.name = "SettlementInvariantError";
  }
}

const AMOUNT_COLUMNS = [
  "paidAmount",
  "totalAmount",
  "sponsorshipAmount",
  "baseAmount",
  "accessAmount",
  "discountAmount",
] as const;

function isAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

interface WrittenState {
  paidAmount: number;
  totalAmount: number;
  sponsorshipAmount: number;
  priceBreakdown: unknown;
}

/**
 * Invariants of the stored money state, checked only where the write touched
 * it, so rows written before the writer existed keep working:
 * - sponsorship ≤ total (when either is written);
 * - a written breakdown is internally consistent and matches the columns
 *   (sponsorshipTotal = sponsorship_amount, total = subtotal − sponsorshipTotal,
 *   subtotal = calculatedBasePrice + accessTotal ≤ total_amount);
 * - a written paid amount is at most the net (total − sponsorship).
 */
export function settlementInvariantViolations(
  row: WrittenState,
  written: ReadonlySet<SettlementColumn>,
): string[] {
  const violations: string[] = [];
  if ((written.has("totalAmount") || written.has("sponsorshipAmount")) && row.sponsorshipAmount > row.totalAmount) {
    violations.push(`sponsorship_amount ${row.sponsorshipAmount} exceeds total_amount ${row.totalAmount}`);
  }
  if (written.has("priceBreakdown")) {
    const pb = row.priceBreakdown as Partial<PriceBreakdown> | null;
    const fields = ["calculatedBasePrice", "accessTotal", "subtotal", "sponsorshipTotal", "total"] as const;
    const bad = fields.filter((field) => !isAmount(pb?.[field]));
    if (!pb || bad.length) {
      violations.push(`price_breakdown ${bad.join(", ") || "is missing"} not a non-negative integer`);
    } else {
      const accessSum = (pb.accessItems ?? []).reduce((sum, item) => sum + item.subtotal, 0);
      if (pb.accessTotal !== accessSum) {
        violations.push(`price_breakdown accessTotal ${pb.accessTotal} is not the sum of its items (${accessSum})`);
      }
      if (pb.subtotal !== pb.calculatedBasePrice! + pb.accessTotal!) {
        violations.push(`price_breakdown subtotal ${pb.subtotal} is not calculatedBasePrice + accessTotal`);
      }
      if (pb.sponsorshipTotal! > pb.subtotal!) {
        violations.push(`price_breakdown sponsorshipTotal ${pb.sponsorshipTotal} exceeds subtotal ${pb.subtotal}`);
      }
      if (pb.total !== pb.subtotal! - pb.sponsorshipTotal!) {
        violations.push(`price_breakdown total ${pb.total} is not subtotal − sponsorshipTotal`);
      }
      if (pb.sponsorshipTotal !== row.sponsorshipAmount) {
        violations.push(
          `price_breakdown sponsorshipTotal ${pb.sponsorshipTotal} differs from sponsorship_amount ${row.sponsorshipAmount}`,
        );
      }
      if (pb.subtotal! > row.totalAmount) {
        violations.push(`price_breakdown subtotal ${pb.subtotal} exceeds total_amount ${row.totalAmount}`);
      }
    }
  }
  if (written.has("paidAmount")) {
    const net = Math.max(0, row.totalAmount - row.sponsorshipAmount);
    if (row.paidAmount > net) {
      violations.push(`paid_amount ${row.paidAmount} exceeds the net ${net}`);
    }
  }
  return violations;
}

/**
 * The only writer of a registration's money columns (SETTLEMENT_COLUMNS).
 *
 * One UPDATE sets the settlement and any other `fields`, then the stored row
 * is checked against the invariants for what was written; a violation throws
 * SettlementInvariantError, which rolls the caller's transaction back. Must
 * run inside a transaction. Returns false when nothing was written: the row
 * is gone, or `expectedUpdatedAt` no longer matches.
 */
export async function applyRegistrationSettlement(
  tx: DbExecutor,
  input: ApplyRegistrationSettlementInput,
): Promise<boolean> {
  const { registrationId, settlement, fields = {}, expectedUpdatedAt } = input;
  if (!isTransactionExecutor(tx)) {
    throw new Error("applyRegistrationSettlement must run inside a transaction");
  }
  const smuggled = SETTLEMENT_COLUMNS.filter((column) => column in fields);
  if (smuggled.length) {
    throw new Error(`Money columns are written only through the settlement: ${smuggled.join(", ")}`);
  }

  const set: RegistrationPatch = { ...fields };
  for (const [column, value] of Object.entries(settlement) as [keyof RegistrationSettlementWrite, unknown][]) {
    if (value !== undefined) (set as Record<string, unknown>)[column] = value;
  }
  if (settlement.priceBreakdown !== undefined) {
    const pb = settlement.priceBreakdown;
    set.baseAmount = pb.calculatedBasePrice;
    set.accessAmount = pb.accessTotal;
    set.discountAmount = calculateDiscountAmount(pb.appliedRules ?? []);
  }
  // drizzle refuses an empty SET ("No values to set"); fail the same way, earlier.
  if (Object.keys(set).length === 0) {
    throw new Error(`Nothing to write for registration ${registrationId}`);
  }
  const written = new Set(SETTLEMENT_COLUMNS.filter((column) => set[column] !== undefined));
  const badAmounts = AMOUNT_COLUMNS.filter((column) => written.has(column) && !isAmount(set[column]));
  if (badAmounts.length) {
    throw new SettlementInvariantError(
      registrationId,
      badAmounts.map((column) => `${column} ${String(set[column])} is not a non-negative integer`),
    );
  }

  const where = expectedUpdatedAt
    ? and(eq(registrations.id, registrationId), eq(registrations.updatedAt, expectedUpdatedAt))
    : eq(registrations.id, registrationId);
  const [row] = await tx
    .update(registrations)
    .set(set)
    .where(where)
    .returning({
      paidAmount: registrations.paidAmount,
      totalAmount: registrations.totalAmount,
      sponsorshipAmount: registrations.sponsorshipAmount,
      priceBreakdown: registrations.priceBreakdown,
    });
  if (!row) return false;

  const violations = settlementInvariantViolations(row, written);
  if (violations.length) throw new SettlementInvariantError(registrationId, violations);
  return true;
}
