import { paidAccessQuantities } from "@app/shared";
import type { DbExecutor } from "../client";
import {
  casDecrementAccessPaidCount,
  casIncrementAccessPaidCount,
  getAccessCapacityInfo,
  getAccessPaidCount,
} from "../queries/access";

/** A registration's paid-capacity state: its status, breakdown and sponsorship-covered items. */
export interface PaidAccessState {
  status: string;
  priceBreakdown: unknown;
  coveredAccessIds?: ReadonlySet<string>;
}

export class AccessNotFoundError extends Error {
  constructor(readonly accessId: string) {
    super(`Access ${accessId} not found`);
    this.name = "AccessNotFoundError";
  }
}

/** Taking `requested` more paid places would exceed the access item's capacity. */
export class AccessCapacityExceededError extends Error {
  constructor(
    readonly accessId: string,
    readonly accessName: string,
    readonly remaining: number | null,
    readonly requested: number,
  ) {
    super(`${accessName} has insufficient capacity (${remaining ?? "unlimited"} spots remaining, requested ${requested})`);
    this.name = "AccessCapacityExceededError";
  }
}

/** Releasing `requested` paid places would take the paid count below zero. */
export class AccessPaidCountUnderflowError extends Error {
  constructor(
    readonly accessId: string,
    readonly paidCount: number,
    readonly requested: number,
  ) {
    super("Paid access count cannot be decremented below zero");
    this.name = "AccessPaidCountUnderflowError";
  }
}

/** Take `quantity` paid places of an access item, within its capacity (atomic CAS). */
export async function takePaidAccess(tx: DbExecutor, accessId: string, quantity: number): Promise<void> {
  if (await casIncrementAccessPaidCount(accessId, quantity, tx)) return;
  const access = await getAccessCapacityInfo(accessId, tx);
  if (!access) throw new AccessNotFoundError(accessId);
  const remaining = access.maxCapacity === null ? null : Math.max(0, access.maxCapacity - access.paidCount);
  throw new AccessCapacityExceededError(accessId, access.name, remaining, quantity);
}

/** Release `quantity` paid places of an access item (atomic CAS, floored at zero). */
export async function releasePaidAccess(tx: DbExecutor, accessId: string, quantity: number): Promise<void> {
  if (await casDecrementAccessPaidCount(accessId, quantity, tx)) return;
  const access = await getAccessPaidCount(accessId, tx);
  if (!access) throw new AccessNotFoundError(accessId);
  throw new AccessPaidCountUnderflowError(accessId, access.paidCount, quantity);
}

/**
 * Move access paid counts from what `before` occupies to what `after`
 * occupies (see paidAccessQuantities): take the increases within capacity
 * and release the decreases, item by item, stopping at the first failure.
 * Returns the access ids whose paid count went up, which may now be full.
 */
export async function applyPaidAccessDelta(
  tx: DbExecutor,
  before: PaidAccessState,
  after: PaidAccessState,
): Promise<{ incremented: string[]; decremented: string[] }> {
  const oldPaid = paidAccessQuantities(before.status, before.priceBreakdown, new Set(before.coveredAccessIds));
  const newPaid = paidAccessQuantities(after.status, after.priceBreakdown, new Set(after.coveredAccessIds));
  const incremented: string[] = [];
  const decremented: string[] = [];
  for (const accessId of new Set([...oldPaid.keys(), ...newPaid.keys()])) {
    const delta = (newPaid.get(accessId) ?? 0) - (oldPaid.get(accessId) ?? 0);
    if (delta > 0) {
      await takePaidAccess(tx, accessId, delta);
      incremented.push(accessId);
    } else if (delta < 0) {
      await releasePaidAccess(tx, accessId, -delta);
      decremented.push(accessId);
    }
  }
  return { incremented, decremented };
}
