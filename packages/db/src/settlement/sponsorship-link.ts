import { asc, eq } from "drizzle-orm";
import type { PriceBreakdown } from "@app/contracts";
import { normalizeSponsorshipCode } from "@app/shared";
import type { DbExecutor } from "../client";
import {
  lockRegistrationForUpdate,
  lockRegistrationsForUpdate,
  lockSponsorshipForUpdate,
  lockSponsorshipsForUpdate,
} from "../locks";
import {
  deleteRegistrationUsages,
  findRegistrationUsageLinks,
  findRegistrationUsagesForRecalc,
} from "../queries/registrations";
import { deleteUsage, findUsage, updateSponsorshipRow, type SponsorshipUsageRow } from "../queries/sponsorships";
import { registrations } from "../schema/registrations";
import { sponsorshipUsages } from "../schema/sponsorships";
import { isTransactionExecutor } from "../txn";
import {
  settleRegistrationTxn,
  type SettlementDecision,
  type SettlementDecisionInput,
  type SettleRegistrationResult,
} from "./settle";
import {
  countSponsorshipUsages,
  linkSponsorshipUsageTxn,
  readLinkableSponsorship,
  sponsorshipAmountFor,
  type LinkableSponsorship,
} from "./sponsorship-code";
import type { RegistrationFieldsPatch, RegistrationPaymentStatus } from "./writer";

// Admin sponsorship link, unlink, cancel/delete and coverage changes on the
// shared settlement code (plan 2.8). Each path locks the sponsorship, then
// its registrations in ascending id order, then settles every registration
// it touched through settleRegistrationTxn (usages recomputed, status
// derived, paid places moved by the old → new delta). Refusals are thrown as
// SponsorshipSettlementError; the caller's transaction then rolls back.

/** Why a sponsorship change was refused. */
export type SponsorshipSettlementRefusal =
  | "SPONSORSHIP_NOT_FOUND"
  | "SPONSORSHIP_CANCELLED"
  | "REGISTRATION_NOT_FOUND"
  /** The sponsorship and the registration belong to different events. */
  | "EVENT_MISMATCH"
  | "ALREADY_LINKED"
  | "NOT_LINKED"
  /** The sponsorship covers nothing the registration holds. */
  | "NOT_APPLICABLE"
  /**
   * The registration's money is settled: a link to PAID/WAIVED/REFUNDED, or
   * a change of a PAID registration's sponsorship amount.
   */
  | "TARGET_SETTLED"
  /** The new sponsorship would leave the registration paid more than it owes. */
  | "EXCEEDS_AMOUNT_DUE";

export class SponsorshipSettlementError extends Error {
  constructor(
    readonly reason: SponsorshipSettlementRefusal,
    readonly details: {
      sponsorshipId?: string;
      registrationId?: string;
      paymentStatus?: string;
      paidAmount?: number;
      amountDue?: number;
    } = {},
  ) {
    super(`Sponsorship change refused: ${reason}`);
    this.name = "SponsorshipSettlementError";
  }
}

/** Statuses no sponsorship may be linked to: the registration's money is settled. */
export const LINK_REFUSED_STATUSES: readonly RegistrationPaymentStatus[] = ["PAID", "WAIVED", "REFUNDED"];

/** A registration as a sponsorship change sees it, read under its lock. */
export interface SponsorshipTarget {
  id: string;
  eventId: string;
  paymentStatus: RegistrationPaymentStatus;
  paymentMethod: string | null;
  paidAmount: number;
  totalAmount: number;
  baseAmount: number;
  sponsorshipAmount: number;
  sponsorshipCode: string | null;
  priceBreakdown: PriceBreakdown;
}

export interface SponsorshipLinkResult {
  /** The sponsorship as locked, before the link. */
  sponsorship: LinkableSponsorship;
  usage: SponsorshipUsageRow;
  settled: SettleRegistrationResult;
}

export interface SponsorshipUnlinkResult {
  registrationId: string;
  /** The removed usage. */
  usage: SponsorshipUsageRow;
  settled: SettleRegistrationResult;
  /** The registration's stored signup code, when the unlink cleared it. */
  clearedSponsorshipCode: string | null;
  /** The payment method before, when the unlink cleared it. */
  clearedPaymentMethod: string | null;
}

export interface SponsorshipReleaseResult {
  /** The sponsorship as locked, before the release. */
  sponsorship: LinkableSponsorship;
  /** One entry per linked registration, ascending id. */
  unlinked: SponsorshipUnlinkResult[];
}

export interface SponsorshipStatusChange {
  before: LinkableSponsorship["status"];
  after: LinkableSponsorship["status"];
}

function assertInTransaction(tx: DbExecutor, name: string): void {
  if (!isTransactionExecutor(tx)) {
    throw new Error(`${name} must run inside a transaction`);
  }
}

/** Read a registration's sponsorship-relevant state (no lock; callers lock first). */
export async function readSponsorshipTarget(tx: DbExecutor, registrationId: string): Promise<SponsorshipTarget | null> {
  const [row] = await tx
    .select({
      id: registrations.id,
      eventId: registrations.eventId,
      paymentStatus: registrations.paymentStatus,
      paymentMethod: registrations.paymentMethod,
      paidAmount: registrations.paidAmount,
      totalAmount: registrations.totalAmount,
      baseAmount: registrations.baseAmount,
      sponsorshipAmount: registrations.sponsorshipAmount,
      sponsorshipCode: registrations.sponsorshipCode,
      priceBreakdown: registrations.priceBreakdown,
    })
    .from(registrations)
    .where(eq(registrations.id, registrationId))
    .limit(1);
  return row ? { ...row, priceBreakdown: row.priceBreakdown as PriceBreakdown } : null;
}

/** The ids of the registrations a sponsorship is linked to, ascending. */
export async function linkedRegistrationIds(tx: DbExecutor, sponsorshipId: string): Promise<string[]> {
  const rows = await tx
    .select({ registrationId: sponsorshipUsages.registrationId })
    .from(sponsorshipUsages)
    .where(eq(sponsorshipUsages.sponsorshipId, sponsorshipId))
    .orderBy(asc(sponsorshipUsages.registrationId));
  return [...new Set(rows.flatMap((row) => (row.registrationId ? [row.registrationId] : [])))].sort();
}

/** The access items covered by a registration's linked sponsorships. */
async function coveredAccessIdsOf(tx: DbExecutor, registrationId: string): Promise<string[]> {
  const usages = await findRegistrationUsagesForRecalc(registrationId, tx);
  return [...new Set(usages.flatMap((usage) => usage.sponsorship.coveredAccessIds))];
}

/**
 * The settlement guard of every sponsorship change: a PAID registration's
 * sponsorship amount must not move (PAID means paid in full against the net
 * it was paid for), and a larger sponsorship must not leave the registration
 * paid more than it now owes.
 */
function guardSponsorshipChange(registrationId: string) {
  return (state: SettlementDecisionInput): SettlementDecision | undefined => {
    const { before } = state;
    if (state.sponsorship === before.sponsorshipAmount) return undefined;
    if (before.paymentStatus === "PAID") {
      throw new SponsorshipSettlementError("TARGET_SETTLED", { registrationId, paymentStatus: before.paymentStatus });
    }
    if (state.sponsorship > before.sponsorshipAmount && before.paidAmount > state.net) {
      throw new SponsorshipSettlementError("EXCEEDS_AMOUNT_DUE", {
        registrationId,
        paidAmount: before.paidAmount,
        amountDue: state.net,
      });
    }
    return undefined;
  };
}

/**
 * Why a sponsorship with this coverage cannot be linked to `target` (read
 * under its lock), or null when it can. Nothing is written, so a caller may
 * check before creating the sponsorship (linked-mode batch).
 */
export async function sponsorshipLinkRefusal(
  tx: DbExecutor,
  coverage: Pick<LinkableSponsorship, "totalAmount" | "coversBasePrice" | "coveredAccessIds">,
  target: SponsorshipTarget,
): Promise<SponsorshipSettlementError | null> {
  const registrationId = target.id;
  if (LINK_REFUSED_STATUSES.includes(target.paymentStatus)) {
    return new SponsorshipSettlementError("TARGET_SETTLED", { registrationId, paymentStatus: target.paymentStatus });
  }
  const pb = target.priceBreakdown;
  const amount = sponsorshipAmountFor(coverage, pb);
  if (amount === 0 && coverage.totalAmount > 0) {
    return new SponsorshipSettlementError("NOT_APPLICABLE", { registrationId });
  }
  // What settleRegistrationTxn will apply once the usage exists.
  const usages = await findRegistrationUsagesForRecalc(registrationId, tx);
  const sponsorship = Math.min(
    usages.reduce((sum, usage) => sum + sponsorshipAmountFor(usage.sponsorship, pb), amount),
    pb.subtotal,
  );
  const net = Math.max(0, target.totalAmount - sponsorship);
  if (target.paidAmount > net) {
    return new SponsorshipSettlementError("EXCEEDS_AMOUNT_DUE", {
      registrationId,
      paidAmount: target.paidAmount,
      amountDue: net,
    });
  }
  return null;
}

/**
 * Link a sponsorship to a registration: lock the sponsorship, then the
 * registration, check the link from the locked rows (see
 * sponsorshipLinkRefusal), insert the usage, set the sponsorship USED and
 * settle the registration. `fields` (e.g. the payment method) are written
 * with the settlement.
 */
export async function linkSponsorshipToRegistrationTxn(
  tx: DbExecutor,
  args: { sponsorshipId: string; registrationId: string; appliedBy: string; fields?: RegistrationFieldsPatch },
): Promise<SponsorshipLinkResult> {
  assertInTransaction(tx, "linkSponsorshipToRegistrationTxn");
  const { sponsorshipId, registrationId } = args;
  if (!(await lockSponsorshipForUpdate(tx, sponsorshipId))) {
    throw new SponsorshipSettlementError("SPONSORSHIP_NOT_FOUND", { sponsorshipId });
  }
  const sponsorship = await readLinkableSponsorship(tx, sponsorshipId);
  if (!sponsorship) throw new SponsorshipSettlementError("SPONSORSHIP_NOT_FOUND", { sponsorshipId });
  if (sponsorship.status === "CANCELLED") {
    throw new SponsorshipSettlementError("SPONSORSHIP_CANCELLED", { sponsorshipId });
  }
  if (!(await lockRegistrationForUpdate(tx, registrationId))) {
    throw new SponsorshipSettlementError("REGISTRATION_NOT_FOUND", { registrationId });
  }
  const target = await readSponsorshipTarget(tx, registrationId);
  if (!target) throw new SponsorshipSettlementError("REGISTRATION_NOT_FOUND", { registrationId });
  if (target.eventId !== sponsorship.eventId) {
    throw new SponsorshipSettlementError("EVENT_MISMATCH", { sponsorshipId, registrationId });
  }
  if (await findUsage(tx, sponsorshipId, registrationId)) {
    throw new SponsorshipSettlementError("ALREADY_LINKED", { sponsorshipId, registrationId });
  }
  const refusal = await sponsorshipLinkRefusal(tx, sponsorship, target);
  if (refusal) throw refusal;

  const coveredAccessIdsBefore = await coveredAccessIdsOf(tx, registrationId);
  const usage = await linkSponsorshipUsageTxn(tx, {
    sponsorship,
    registrationId,
    priceBreakdown: target.priceBreakdown,
    appliedBy: args.appliedBy,
  });
  const settled = await settleRegistrationTxn(tx, registrationId, {
    coveredAccessIdsBefore,
    decide: guardSponsorshipChange(registrationId),
    fields: args.fields,
  });
  if (!settled) throw new SponsorshipSettlementError("REGISTRATION_NOT_FOUND", { registrationId });
  return { sponsorship, usage, settled };
}

/**
 * Remove a sponsorship's usage from a registration; both rows are locked by
 * the caller. Settles the registration with the sponsorship recomputed from
 * the remaining usages (0 when none remain), clears the registration's
 * signup code when it is this sponsorship's code (and drops that code's
 * breakdown line), and clears a LAB_SPONSORSHIP payment method when no usage
 * remains. The sponsorship's own status is left to the caller.
 */
async function unlinkLockedUsage(
  tx: DbExecutor,
  sponsorship: LinkableSponsorship,
  registrationId: string,
): Promise<SponsorshipUnlinkResult> {
  const usage = await findUsage(tx, sponsorship.id, registrationId);
  const target = usage ? await readSponsorshipTarget(tx, registrationId) : null;
  if (!usage || !target) {
    throw new SponsorshipSettlementError("NOT_LINKED", { sponsorshipId: sponsorship.id, registrationId });
  }
  const coveredAccessIdsBefore = await coveredAccessIdsOf(tx, registrationId);
  await deleteUsage(tx, usage.id);
  const remaining = (await findRegistrationUsagesForRecalc(registrationId, tx)).length;

  const code = normalizeSponsorshipCode(sponsorship.code);
  const fields: RegistrationFieldsPatch = {};
  const clearedSponsorshipCode =
    code !== null && normalizeSponsorshipCode(target.sponsorshipCode) === code ? target.sponsorshipCode : null;
  if (clearedSponsorshipCode !== null) fields.sponsorshipCode = null;
  const clearedPaymentMethod =
    remaining === 0 && target.paymentMethod === "LAB_SPONSORSHIP" ? target.paymentMethod : null;
  if (clearedPaymentMethod !== null) fields.paymentMethod = null;

  const lines = target.priceBreakdown.sponsorships ?? [];
  const keptLines = lines.filter((line) => normalizeSponsorshipCode(line.code) !== code);
  const settled = await settleRegistrationTxn(tx, registrationId, {
    coveredAccessIdsBefore,
    keepUnlinkedSponsorship: false,
    ...(keptLines.length !== lines.length
      ? { priceBreakdown: { ...target.priceBreakdown, sponsorships: keptLines }, totalAmount: target.totalAmount }
      : {}),
    decide: guardSponsorshipChange(registrationId),
    fields,
  });
  if (!settled) throw new SponsorshipSettlementError("NOT_LINKED", { sponsorshipId: sponsorship.id, registrationId });
  return { registrationId, usage, settled, clearedSponsorshipCode, clearedPaymentMethod };
}

/**
 * The sponsorship's status once its usages changed: USED while linked,
 * PENDING when no usage remains; CANCELLED stays CANCELLED.
 */
export async function settleSponsorshipStatusTxn(
  tx: DbExecutor,
  sponsorship: Pick<LinkableSponsorship, "id" | "status">,
): Promise<SponsorshipStatusChange> {
  if (sponsorship.status === "CANCELLED") return { before: "CANCELLED", after: "CANCELLED" };
  const after = (await countSponsorshipUsages(tx, sponsorship.id)) > 0 ? "USED" : "PENDING";
  if (after !== sponsorship.status) await updateSponsorshipRow(tx, sponsorship.id, { status: after });
  return { before: sponsorship.status, after };
}

/**
 * Unlink a sponsorship from one registration: lock the sponsorship, then
 * the registration, remove the usage and settle (see unlinkLockedUsage),
 * then set the sponsorship PENDING when no usage remains.
 */
export async function unlinkSponsorshipFromRegistrationTxn(
  tx: DbExecutor,
  args: { sponsorshipId: string; registrationId: string },
): Promise<SponsorshipUnlinkResult & { sponsorship: LinkableSponsorship; status: SponsorshipStatusChange }> {
  assertInTransaction(tx, "unlinkSponsorshipFromRegistrationTxn");
  const { sponsorshipId, registrationId } = args;
  const sponsorship = (await lockSponsorshipForUpdate(tx, sponsorshipId))
    ? await readLinkableSponsorship(tx, sponsorshipId)
    : null;
  if (!sponsorship || !(await lockRegistrationForUpdate(tx, registrationId))) {
    throw new SponsorshipSettlementError("NOT_LINKED", { sponsorshipId, registrationId });
  }
  const unlinked = await unlinkLockedUsage(tx, sponsorship, registrationId);
  const status = await settleSponsorshipStatusTxn(tx, sponsorship);
  return { ...unlinked, sponsorship, status };
}

/**
 * Unlink a sponsorship from every registration it is linked to, before the
 * caller cancels or deletes it: lock the sponsorship, then its registrations
 * in ascending id order, then unlink and settle each. Null when the
 * sponsorship does not exist. The sponsorship's status is left to the caller.
 */
export async function releaseSponsorshipTxn(
  tx: DbExecutor,
  sponsorshipId: string,
): Promise<SponsorshipReleaseResult | null> {
  assertInTransaction(tx, "releaseSponsorshipTxn");
  if (!(await lockSponsorshipForUpdate(tx, sponsorshipId))) return null;
  const sponsorship = await readLinkableSponsorship(tx, sponsorshipId);
  if (!sponsorship) return null;
  const locked = await lockRegistrationsForUpdate(tx, await linkedRegistrationIds(tx, sponsorshipId));
  const unlinked: SponsorshipUnlinkResult[] = [];
  for (const registrationId of locked) unlinked.push(await unlinkLockedUsage(tx, sponsorship, registrationId));
  return { sponsorship, unlinked };
}

/** A sponsorship's coverage, as a coverage change sets it. */
export interface SponsorshipCoverage {
  coversBasePrice: boolean;
  coveredAccessIds: string[];
  totalAmount: number;
}

/**
 * Change a sponsorship's coverage and settle every linked registration
 * against it: lock the sponsorship, then its registrations in ascending id
 * order, record what each registration had covered, write the new coverage
 * (with any other sponsorship `fields`), then settle each registration (its
 * usage amounts are recomputed by the settlement). Null when the sponsorship
 * does not exist.
 */
export async function changeSponsorshipCoverageTxn(
  tx: DbExecutor,
  sponsorshipId: string,
  coverage: SponsorshipCoverage,
  fields: Omit<Parameters<typeof updateSponsorshipRow>[2], keyof SponsorshipCoverage | "status"> = {},
): Promise<{ sponsorship: LinkableSponsorship; settled: Array<SettleRegistrationResult & { registrationId: string }> } | null> {
  assertInTransaction(tx, "changeSponsorshipCoverageTxn");
  if (!(await lockSponsorshipForUpdate(tx, sponsorshipId))) return null;
  const sponsorship = await readLinkableSponsorship(tx, sponsorshipId);
  if (!sponsorship) return null;
  const locked = await lockRegistrationsForUpdate(tx, await linkedRegistrationIds(tx, sponsorshipId));
  const coveredBefore = new Map<string, string[]>();
  for (const registrationId of locked) {
    coveredBefore.set(registrationId, await coveredAccessIdsOf(tx, registrationId));
  }
  await updateSponsorshipRow(tx, sponsorshipId, { ...fields, ...coverage });

  const settled: Array<SettleRegistrationResult & { registrationId: string }> = [];
  for (const registrationId of locked) {
    const result = await settleRegistrationTxn(tx, registrationId, {
      coveredAccessIdsBefore: coveredBefore.get(registrationId),
      decide: guardSponsorshipChange(registrationId),
    });
    if (result) settled.push({ ...result, registrationId });
  }
  return { sponsorship, settled };
}

/**
 * Lock the sponsorships linked to a registration, in ascending id order,
 * before the registration itself (lock order sponsorship → registration).
 * Returns their ids. For paths that then lock and remove the registration
 * (registration delete).
 */
export async function lockRegistrationSponsorships(tx: DbExecutor, registrationId: string): Promise<string[]> {
  assertInTransaction(tx, "lockRegistrationSponsorships");
  const links = await findRegistrationUsageLinks(registrationId, tx);
  return lockSponsorshipsForUpdate(tx, links.map((link) => link.sponsorshipId));
}

/**
 * Remove a registration's sponsorship usages before it is deleted. The
 * caller locked the linked sponsorships (lockRegistrationSponsorships), then
 * the registration. A usage added in between is locked here, out of order; a
 * resulting deadlock aborts and withLockingTxn retries. Each sponsorship goes
 * back to PENDING when no usage remains; CANCELLED stays CANCELLED. Returns
 * the access items the usages covered (for the paid places the registration
 * held) and each sponsorship's status change.
 */
export async function releaseRegistrationUsagesTxn(
  tx: DbExecutor,
  registrationId: string,
): Promise<{ coveredAccessIds: string[]; sponsorships: Array<SponsorshipStatusChange & { id: string }> }> {
  assertInTransaction(tx, "releaseRegistrationUsagesTxn");
  const links = await findRegistrationUsageLinks(registrationId, tx);
  const sponsorshipIds = await lockSponsorshipsForUpdate(tx, links.map((link) => link.sponsorshipId));
  const coveredAccessIds = await coveredAccessIdsOf(tx, registrationId);
  if (links.length > 0) await deleteRegistrationUsages(registrationId, tx);
  const statuses: Array<SponsorshipStatusChange & { id: string }> = [];
  for (const id of sponsorshipIds) {
    const sponsorship = await readLinkableSponsorship(tx, id);
    if (sponsorship) statuses.push({ id, ...(await settleSponsorshipStatusTxn(tx, sponsorship)) });
  }
  return { coveredAccessIds, sponsorships: statuses };
}
