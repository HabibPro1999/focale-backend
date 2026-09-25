import { eq } from "drizzle-orm";
import type { PriceBreakdown } from "@app/contracts";
import {
  calculateApplicableAmount,
  deriveSettlement,
  netBreakdown,
  type SettlementStatus,
} from "@app/shared";
import type { DbExecutor } from "../client";
import { lockRegistrationForUpdate } from "../locks";
import { findRegistrationUsagesForRecalc } from "../queries/registrations";
import { updateUsageAmount } from "../queries/sponsorships";
import { registrations } from "../schema/registrations";
import { isTransactionExecutor } from "../txn";
import { applyPaidAccessDelta } from "./paid-access";
import {
  applyRegistrationSettlement,
  type RegistrationFieldsPatch,
  type RegistrationPaymentStatus,
  type RegistrationSettlementWrite,
} from "./writer";

/** A registration's money state, as stored. */
export interface SettlementSnapshot {
  paymentStatus: RegistrationPaymentStatus;
  paidAt: Date | null;
  paidAmount: number;
  totalAmount: number;
  sponsorshipAmount: number;
  priceBreakdown: PriceBreakdown;
}

export interface SettleRegistrationOptions {
  /**
   * The breakdown to settle against, e.g. after repricing (its sponsorship
   * fields are recomputed). Defaults to the stored breakdown.
   */
  priceBreakdown?: PriceBreakdown;
  /** Gross total_amount; defaults to the new breakdown's subtotal, else the stored value. */
  totalAmount?: number;
  /** A new paid_amount; defaults to the stored one (not written). */
  paidAmount?: number;
  /**
   * An explicit status (admin and payment paths). When omitted the status is
   * derived from the amounts (deriveSettlement: sticky statuses stay).
   */
  paymentStatus?: RegistrationPaymentStatus;
  /** paid_at with an explicit status; defaults to the stored value. */
  paidAt?: Date | null;
  /**
   * Decide the status (and paid amount/date) from the amounts recomputed
   * under the lock, e.g. to validate a payment or a price change against the
   * fresh net. A returned decision takes precedence over
   * paymentStatus/paidAmount/paidAt; returning nothing keeps them. Throwing
   * aborts the settlement; the caller's transaction then rolls back.
   */
  decide?: (state: SettlementDecisionInput) => SettlementDecision | undefined;
  /**
   * Access items sponsorships covered before this change, when the caller
   * changed the registration's sponsorship usages first. Defaults to what
   * they cover now.
   */
  coveredAccessIdsBefore?: Iterable<string>;
  /**
   * Without linked usages, keep the breakdown's own sponsorshipTotal (a code
   * priced at signup but never linked). Default true; false when the caller
   * just removed the last usage, so the sponsorship drops to 0.
   */
  keepUnlinkedSponsorship?: boolean;
  /** Other columns written in the same UPDATE. */
  fields?: RegistrationFieldsPatch;
  /** Settle only if updated_at still has this value; otherwise change nothing. */
  expectedUpdatedAt?: Date;
  now?: Date;
}

/** What `decide` sees: the stored state and the amounts this settlement will write. */
export interface SettlementDecisionInput {
  before: SettlementSnapshot;
  /** total_amount after this settlement. */
  gross: number;
  /** Sponsorship recomputed from the linked usages, capped at the subtotal. */
  sponsorship: number;
  /** gross − sponsorship, floored at 0: what the registrant owes in total. */
  net: number;
}

export interface SettlementDecision {
  /** An explicit status; when omitted it is derived from the amounts and the paid amount below. */
  paymentStatus?: RegistrationPaymentStatus;
  /** Written when given; otherwise the stored paid amount is kept. */
  paidAmount?: number;
  /** Written when given; otherwise the stored paid_at is kept. */
  paidAt?: Date | null;
}

export interface SettleRegistrationResult {
  /**
   * False when `expectedUpdatedAt` no longer matched: nothing was changed.
   * True otherwise, including when no column needed to change.
   */
  written: boolean;
  eventId: string;
  before: SettlementSnapshot;
  after: SettlementSnapshot;
  /** Access items covered by the registration's linked sponsorships. */
  coveredAccessIds: string[];
  /** Access paid counts moved by this settlement; `incremented` items may now be full. */
  paidAccess: { incremented: string[]; decremented: string[] };
}

async function readSettlementRow(tx: DbExecutor, registrationId: string) {
  const [row] = await tx
    .select({
      eventId: registrations.eventId,
      updatedAt: registrations.updatedAt,
      paymentStatus: registrations.paymentStatus,
      paidAt: registrations.paidAt,
      paidAmount: registrations.paidAmount,
      totalAmount: registrations.totalAmount,
      sponsorshipAmount: registrations.sponsorshipAmount,
      priceBreakdown: registrations.priceBreakdown,
    })
    .from(registrations)
    .where(eq(registrations.id, registrationId))
    .limit(1);
  return row;
}

/**
 * Recompute each linked sponsorship usage against `priceBreakdown`
 * (calculateApplicableAmount), store the amounts that changed, and return
 * the sponsorship to apply and the access items the sponsorships cover.
 * Without usages the breakdown's own sponsorshipTotal (codes priced at
 * signup) is kept unless `keepUnlinked` is false. Either way it is capped at
 * the subtotal.
 */
export async function recomputeRegistrationSponsorship(
  tx: DbExecutor,
  registrationId: string,
  priceBreakdown: PriceBreakdown,
  keepUnlinked = true,
): Promise<{ sponsorship: number; coveredAccessIds: string[] }> {
  const usages = await findRegistrationUsagesForRecalc(registrationId, tx);
  const accessTypeIds = priceBreakdown.accessItems.map((item) => item.accessId);
  const covered = new Set<string>();
  let sponsorship = usages.length === 0 && keepUnlinked ? priceBreakdown.sponsorshipTotal : 0;
  for (const usage of usages) {
    for (const accessId of usage.sponsorship.coveredAccessIds) covered.add(accessId);
    const amountApplied = calculateApplicableAmount(usage.sponsorship, {
      totalAmount: priceBreakdown.subtotal,
      baseAmount: priceBreakdown.calculatedBasePrice,
      accessTypeIds,
      priceBreakdown,
    });
    sponsorship += amountApplied;
    if (amountApplied !== usage.amountApplied) {
      await updateUsageAmount(tx, usage.id, amountApplied);
    }
  }
  return { sponsorship: Math.min(sponsorship, priceBreakdown.subtotal), coveredAccessIds: [...covered] };
}

/**
 * Settle one registration: lock it, load its sponsorship usages, recompute
 * their amounts, derive the status (or apply an explicit one), move access
 * paid counts by the old → new delta, then write through
 * applyRegistrationSettlement. Only changed money columns are written.
 *
 * Runs in the caller's transaction (withLockingTxn). Returns null when the
 * registration does not exist. Access capacity errors are thrown as
 * AccessCapacityExceededError and friends; `paidAccess.incremented` lists the
 * items that may now be full, for the caller's capacity handling.
 */
export async function settleRegistrationTxn(
  tx: DbExecutor,
  registrationId: string,
  options: SettleRegistrationOptions = {},
): Promise<SettleRegistrationResult | null> {
  if (!isTransactionExecutor(tx)) {
    throw new Error("settleRegistrationTxn must run inside a transaction");
  }
  if (!(await lockRegistrationForUpdate(tx, registrationId))) return null;
  const row = await readSettlementRow(tx, registrationId);
  if (!row) return null;

  const before: SettlementSnapshot = {
    paymentStatus: row.paymentStatus,
    paidAt: row.paidAt,
    paidAmount: row.paidAmount,
    totalAmount: row.totalAmount,
    sponsorshipAmount: row.sponsorshipAmount,
    priceBreakdown: row.priceBreakdown as PriceBreakdown,
  };
  if (options.expectedUpdatedAt && row.updatedAt.getTime() !== options.expectedUpdatedAt.getTime()) {
    return {
      written: false,
      eventId: row.eventId,
      before,
      after: before,
      coveredAccessIds: [],
      paidAccess: { incremented: [], decremented: [] },
    };
  }

  const repriced = options.priceBreakdown !== undefined;
  const grossBreakdown = options.priceBreakdown ?? before.priceBreakdown;
  const { sponsorship, coveredAccessIds } = await recomputeRegistrationSponsorship(
    tx,
    registrationId,
    grossBreakdown,
    options.keepUnlinkedSponsorship ?? true,
  );
  const priceBreakdown = netBreakdown(grossBreakdown, sponsorship);
  const totalAmount = options.totalAmount ?? (repriced ? priceBreakdown.subtotal : before.totalAmount);
  const decision = options.decide?.({
    before,
    gross: totalAmount,
    sponsorship,
    net: Math.max(0, totalAmount - sponsorship),
  });
  const chosen: SettlementDecision = decision ?? {
    paymentStatus: options.paymentStatus,
    paidAmount: options.paidAmount,
    paidAt: options.paidAt,
  };
  const explicitPaidAmount = chosen.paidAmount;
  const paidAmount = explicitPaidAmount ?? before.paidAmount;

  let paymentStatus: RegistrationPaymentStatus;
  let paidAt: Date | null;
  if (chosen.paymentStatus !== undefined) {
    paymentStatus = chosen.paymentStatus;
    paidAt = chosen.paidAt !== undefined ? chosen.paidAt : before.paidAt;
  } else {
    const derived = deriveSettlement({
      gross: totalAmount,
      sponsorship,
      paid: paidAmount,
      currentStatus: before.paymentStatus as SettlementStatus,
      paidAt: before.paidAt,
      now: options.now ?? new Date(),
    });
    paymentStatus = derived.status;
    paidAt = derived.paidAt;
  }
  const after: SettlementSnapshot = { paymentStatus, paidAt, paidAmount, totalAmount, sponsorshipAmount: sponsorship, priceBreakdown };

  const coveredNow = new Set(coveredAccessIds);
  const paidAccess = await applyPaidAccessDelta(
    tx,
    {
      status: before.paymentStatus,
      priceBreakdown: before.priceBreakdown,
      coveredAccessIds: new Set(options.coveredAccessIdsBefore ?? coveredNow),
    },
    { status: paymentStatus, priceBreakdown, coveredAccessIds: coveredNow },
  );

  const breakdownChanged =
    repriced ||
    before.priceBreakdown?.sponsorshipTotal !== priceBreakdown.sponsorshipTotal ||
    before.priceBreakdown?.total !== priceBreakdown.total;
  const settlement: RegistrationSettlementWrite = {};
  if (breakdownChanged) {
    settlement.priceBreakdown = priceBreakdown;
    settlement.totalAmount = totalAmount;
    settlement.sponsorshipAmount = sponsorship;
  } else {
    if (totalAmount !== before.totalAmount) settlement.totalAmount = totalAmount;
    if (sponsorship !== before.sponsorshipAmount) settlement.sponsorshipAmount = sponsorship;
  }
  if (explicitPaidAmount !== undefined) settlement.paidAmount = paidAmount;
  if (paymentStatus !== before.paymentStatus) settlement.paymentStatus = paymentStatus;
  if ((paidAt?.getTime() ?? null) !== (before.paidAt?.getTime() ?? null)) settlement.paidAt = paidAt;

  if (Object.keys(settlement).length > 0 || Object.keys(options.fields ?? {}).length > 0) {
    await applyRegistrationSettlement(tx, { registrationId, settlement, fields: options.fields });
  }
  return { written: true, eventId: row.eventId, before, after, coveredAccessIds, paidAccess };
}
