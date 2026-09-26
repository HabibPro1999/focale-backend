import { and, asc, eq, gt, inArray, notExists, or, sql } from "drizzle-orm";
import type { AppEvent, PriceBreakdown } from "@app/contracts";
import {
  deriveSettlement,
  isFullySettled,
  netBreakdown,
  normalizeSponsorshipCode,
  paidAccessQuantities,
  type SettlementStatus,
} from "@app/shared";
import { getDb, type DbExecutor } from "../client";
import { lockRegistrationForUpdate, lockSponsorshipForUpdate } from "../locks";
import { insertAuditLog } from "../outbox";
import { findRegistrationUsagesForRecalc } from "../queries/registrations";
import { eventAccess, events } from "../schema/events-access";
import { registrations } from "../schema/registrations";
import { sponsorships, sponsorshipUsages } from "../schema/sponsorships";
import { withLockingTxn } from "../txn";
import { emitSettlementEvents, settlementEventPair } from "./events";
import { enqueueAccessDrops } from "./access-drop";
import { AccessCapacityExceededError } from "./paid-access";
import { settleRegistrationTxn } from "./settle";
import {
  linkSponsorshipUsageTxn,
  readLinkableSponsorship,
  sponsorshipAmountFor,
  type LinkableSponsorship,
} from "./sponsorship-code";

// Repair of signup codes stored before codes were consumed (plan 2.7). Until
// 2.7 a signup stored the code and its amount on the registration but never
// linked the sponsorship, so the code stayed PENDING and reusable, and the
// amount lived only in the breakdown (kept, capped, by repricing: 2.6c).
//
// The plan is read-only. A code with exactly one holder (the registration
// that stored it; no other registration stores it, links it or is its
// target) is linked like a signup: usage + USED, then settleRegistrationTxn.
// Everything else goes to a business-decision list. Applying a link
// re-plans the code under the sponsorship and registration locks and changes
// nothing unless the fresh plan is the one that was reviewed.
//
// Every other writer of these rows locks first since plan 2.8, so --apply
// can run while the app is up. A link that fills an access item enqueues
// the capacity drop (access.capacityReached) like any other settlement.
//
// clearRegistrationSponsorshipCode is the per-registration decision tool for
// the business-decision list (an unknown code, the losing claimants of a
// shared code): it clears the stored code and, without a linked usage, the
// signup amount priced from it. Only for registrations an operator names.

export const SPONSORSHIP_CODE_REPAIR_ACTOR = "SYSTEM:repair-sponsorship-code-usages";

export type SponsorshipCodeDecisionReason =
  /** The stored code matches no sponsorship of the registration's event. */
  | "UNKNOWN_CODE"
  /** The code's sponsorship was cancelled. */
  | "CANCELLED_CODE"
  /** Several registrations store, are linked to, or are the target of this code. */
  | "SEVERAL_CLAIMANTS"
  /** A sponsorship amount with no usage and no stored code. */
  | "AMOUNT_WITHOUT_CODE"
  /** The only claimant was refunded. */
  | "REFUNDED_CLAIMANT"
  /** Linking would change the amount of a PAID/WAIVED/VERIFYING registration. */
  | "SETTLED_AMOUNT_CHANGE"
  /** Linking would move a fully settled registration to another status. */
  | "SETTLED_STATUS_CHANGE"
  /** Linking would leave the claimant paid more than it owes. */
  | "OVERPAID"
  /** The stored breakdown cannot be settled (missing or invalid amounts). */
  | "INVALID_BREAKDOWN";

export interface SponsorshipCodeDecision {
  reason: SponsorshipCodeDecisionReason;
  eventId: string;
  /** The normalized code, or null for AMOUNT_WITHOUT_CODE. */
  code: string | null;
  sponsorshipId: string | null;
  /** The registrations concerned, ascending. */
  registrationIds: string[];
  detail: string;
}

/** A registration's money state, as the plan saw it. */
export interface RepairRegistrationState {
  paymentStatus: string;
  paidAmount: number;
  totalAmount: number;
  sponsorshipAmount: number;
  updatedAt: string;
}

export interface SponsorshipCodeLink {
  eventId: string;
  code: string;
  sponsorshipId: string;
  registrationId: string;
  referenceNumber: string | null;
  before: RepairRegistrationState;
  after: { paymentStatus: string; sponsorshipAmount: number; amountDue: number };
  /** Paid places moved by the link, by access id (positive = taken). */
  paidPlaces: Record<string, number>;
  /** Access items the link would fill to capacity (their drop is enqueued on apply). */
  fillsCapacity: string[];
}

export interface SponsorshipCodeRepairPlan {
  links: SponsorshipCodeLink[];
  decisions: SponsorshipCodeDecision[];
  /** Codes whose only claimant is already linked: nothing to do. */
  alreadyLinked: number;
}

interface ClaimantRow {
  id: string;
  eventId: string;
  referenceNumber: string | null;
  createdAt: Date;
  updatedAt: Date;
  paymentStatus: string;
  paidAt: Date | null;
  paidAmount: number;
  totalAmount: number;
  sponsorshipAmount: number;
  sponsorshipCode: string | null;
  priceBreakdown: unknown;
}

const claimantColumns = {
  id: registrations.id,
  eventId: registrations.eventId,
  referenceNumber: registrations.referenceNumber,
  createdAt: registrations.createdAt,
  updatedAt: registrations.updatedAt,
  paymentStatus: registrations.paymentStatus,
  paidAt: registrations.paidAt,
  paidAmount: registrations.paidAmount,
  totalAmount: registrations.totalAmount,
  sponsorshipAmount: registrations.sponsorshipAmount,
  sponsorshipCode: registrations.sponsorshipCode,
  priceBreakdown: registrations.priceBreakdown,
};

const trimmedCode = sql`upper(trim(${registrations.sponsorshipCode}))`;

function ascending(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

function stateOf(row: ClaimantRow): RepairRegistrationState {
  return {
    paymentStatus: row.paymentStatus,
    paidAmount: row.paidAmount,
    totalAmount: row.totalAmount,
    sponsorshipAmount: row.sponsorshipAmount,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isSettleableBreakdown(value: unknown): value is PriceBreakdown {
  const pb = value as Partial<PriceBreakdown> | null;
  return (
    !!pb &&
    Number.isInteger(pb.subtotal) &&
    Number.isInteger(pb.calculatedBasePrice) &&
    Array.isArray(pb.accessItems) &&
    pb.accessItems.every((item) => typeof item?.accessId === "string" && Number.isInteger(item.subtotal))
  );
}

/** The event's registrations storing this (normalized) code, oldest first. */
async function findClaimantRows(db: DbExecutor, eventId: string, code: string): Promise<ClaimantRow[]> {
  return db
    .select(claimantColumns)
    .from(registrations)
    .where(
      and(
        eq(registrations.eventId, eventId),
        or(eq(registrations.sponsorshipCode, code), sql`${trimmedCode} = ${code}`),
      ),
    )
    .orderBy(asc(registrations.createdAt), asc(registrations.id));
}

async function findSponsorshipIdByCode(db: DbExecutor, eventId: string, code: string): Promise<string | null> {
  const [row] = await db
    .select({ id: sponsorships.id })
    .from(sponsorships)
    .where(and(eq(sponsorships.eventId, eventId), eq(sponsorships.code, code)))
    .limit(1);
  return row?.id ?? null;
}

async function linkedRegistrationIds(db: DbExecutor, sponsorshipId: string): Promise<string[]> {
  const rows = await db
    .select({ registrationId: sponsorshipUsages.registrationId })
    .from(sponsorshipUsages)
    .where(eq(sponsorshipUsages.sponsorshipId, sponsorshipId));
  return rows.flatMap((row) => (row.registrationId ? [row.registrationId] : []));
}

/** Items whose paid count would reach the capacity after taking `increments`. */
async function itemsFilledBy(db: DbExecutor, increments: Record<string, number>): Promise<string[]> {
  const ids = Object.entries(increments).filter(([, delta]) => delta > 0).map(([id]) => id);
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: eventAccess.id, maxCapacity: eventAccess.maxCapacity, paidCount: eventAccess.paidCount })
    .from(eventAccess)
    .where(inArray(eventAccess.id, ids));
  return ascending(
    rows
      .filter((row) => row.maxCapacity !== null && row.paidCount + (increments[row.id] ?? 0) >= row.maxCapacity)
      .map((row) => row.id),
  );
}

/**
 * What linking `sponsorship` to `claimant` would settle to, computed the way
 * settleRegistrationTxn does (usages recomputed against the stored breakdown,
 * capped at the subtotal; status derived; paid places by the old → new delta).
 */
async function planLinkOutcome(
  db: DbExecutor,
  claimant: ClaimantRow,
  sponsorship: LinkableSponsorship,
  code: string,
): Promise<SponsorshipCodeLink | SponsorshipCodeDecision> {
  const decision = (reason: SponsorshipCodeDecisionReason, detail: string): SponsorshipCodeDecision => ({
    reason,
    eventId: claimant.eventId,
    code,
    sponsorshipId: sponsorship.id,
    registrationIds: [claimant.id],
    detail,
  });
  if (claimant.paymentStatus === "REFUNDED") {
    return decision("REFUNDED_CLAIMANT", "the only claimant was refunded");
  }
  const pb = claimant.priceBreakdown;
  if (!isSettleableBreakdown(pb)) {
    return decision("INVALID_BREAKDOWN", "the stored price breakdown has no subtotal/base/access items");
  }
  const usages = await findRegistrationUsagesForRecalc(claimant.id, db);
  const coveredBefore = new Set(usages.flatMap((usage) => usage.sponsorship.coveredAccessIds));
  const coveredAfter = new Set([...coveredBefore, ...sponsorship.coveredAccessIds]);
  const sponsorshipAmount = Math.min(
    [...usages.map((usage) => usage.sponsorship), sponsorship].reduce(
      (sum, linked) => sum + sponsorshipAmountFor(linked, pb),
      0,
    ),
    pb.subtotal,
  );
  let derived: ReturnType<typeof deriveSettlement>;
  try {
    derived = deriveSettlement({
      gross: claimant.totalAmount,
      sponsorship: sponsorshipAmount,
      paid: claimant.paidAmount,
      currentStatus: claimant.paymentStatus as SettlementStatus,
      paidAt: claimant.paidAt,
      now: new Date(),
    });
  } catch (err) {
    return decision("INVALID_BREAKDOWN", err instanceof Error ? err.message : String(err));
  }
  const amountChanged = sponsorshipAmount !== claimant.sponsorshipAmount;
  const sticky = ["PAID", "WAIVED", "VERIFYING"].includes(claimant.paymentStatus);
  if (sticky && amountChanged) {
    return decision(
      "SETTLED_AMOUNT_CHANGE",
      `${claimant.paymentStatus}: sponsorship ${claimant.sponsorshipAmount} → ${sponsorshipAmount}`,
    );
  }
  if (isFullySettled(claimant.paymentStatus) && derived.status !== claimant.paymentStatus) {
    return decision("SETTLED_STATUS_CHANGE", `${claimant.paymentStatus} → ${derived.status}`);
  }
  if (claimant.paidAmount > derived.net) {
    return decision("OVERPAID", `paid ${claimant.paidAmount} > net ${derived.net}`);
  }

  const oldPaid = paidAccessQuantities(claimant.paymentStatus, pb, coveredBefore);
  const newPaid = paidAccessQuantities(derived.status, netBreakdown(pb, sponsorshipAmount), coveredAfter);
  const paidPlaces: Record<string, number> = {};
  for (const accessId of ascending([...oldPaid.keys(), ...newPaid.keys()])) {
    const delta = (newPaid.get(accessId) ?? 0) - (oldPaid.get(accessId) ?? 0);
    if (delta !== 0) paidPlaces[accessId] = delta;
  }
  return {
    eventId: claimant.eventId,
    code,
    sponsorshipId: sponsorship.id,
    registrationId: claimant.id,
    referenceNumber: claimant.referenceNumber,
    before: stateOf(claimant),
    after: { paymentStatus: derived.status, sponsorshipAmount, amountDue: derived.due },
    paidPlaces,
    fillsCapacity: await itemsFilledBy(db, paidPlaces),
  };
}

type CodePlan =
  | { kind: "link"; link: SponsorshipCodeLink }
  | { kind: "decision"; decision: SponsorshipCodeDecision }
  | { kind: "linked" }
  | { kind: "none" };

/** Plan one (event, normalized code). */
async function planCode(db: DbExecutor, eventId: string, code: string): Promise<CodePlan> {
  const claimants = await findClaimantRows(db, eventId, code);
  if (claimants.length === 0) return { kind: "none" };
  const claimantIds = ascending(claimants.map((row) => row.id));
  const sponsorshipId = await findSponsorshipIdByCode(db, eventId, code);
  const sponsorship = sponsorshipId ? await readLinkableSponsorship(db, sponsorshipId) : null;
  const decision = (reason: SponsorshipCodeDecisionReason, registrationIds: string[], detail: string): CodePlan => ({
    kind: "decision",
    decision: { reason, eventId, code, sponsorshipId: sponsorship?.id ?? null, registrationIds, detail },
  });
  if (!sponsorship) return decision("UNKNOWN_CODE", claimantIds, "no sponsorship of the event has this code");

  const linked = new Set(await linkedRegistrationIds(db, sponsorship.id));
  const unlinked = claimants.filter((row) => !linked.has(row.id));
  if (sponsorship.status === "CANCELLED") {
    return decision("CANCELLED_CODE", ascending([...claimantIds, ...linked]), "the sponsorship was cancelled");
  }
  if (unlinked.length === 0 && linked.size === 1) return { kind: "linked" };
  const holders = ascending([
    ...claimantIds,
    ...linked,
    ...(sponsorship.targetRegistrationId ? [sponsorship.targetRegistrationId] : []),
  ]);
  if (holders.length > 1) {
    const parts = [
      `stored by ${claimantIds.length}`,
      linked.size > 0 ? `linked to ${linked.size}` : null,
      sponsorship.targetRegistrationId ? `target ${sponsorship.targetRegistrationId}` : null,
    ].filter(Boolean);
    return decision("SEVERAL_CLAIMANTS", holders, parts.join(", "));
  }
  if (unlinked.length === 0) return { kind: "linked" };
  const outcome = await planLinkOutcome(db, unlinked[0], sponsorship, code);
  return "reason" in outcome ? { kind: "decision", decision: outcome } : { kind: "link", link: outcome };
}

/**
 * Read-only plan: every registration that stores a signup code (grouped by
 * event and normalized code) or carries a sponsorship amount without any
 * usage. Optionally limited to one event.
 */
export async function planSponsorshipCodeRepair(
  options: { eventId?: string } = {},
  db: DbExecutor = getDb(),
): Promise<SponsorshipCodeRepairPlan> {
  const unlinkedAmount = and(
    gt(registrations.sponsorshipAmount, 0),
    notExists(
      db
        .select({ one: sql`1` })
        .from(sponsorshipUsages)
        .where(eq(sponsorshipUsages.registrationId, registrations.id)),
    ),
  );
  const candidates = await db
    .select({ id: registrations.id, eventId: registrations.eventId, sponsorshipCode: registrations.sponsorshipCode })
    .from(registrations)
    .where(
      and(
        options.eventId ? eq(registrations.eventId, options.eventId) : undefined,
        or(sql`nullif(trim(${registrations.sponsorshipCode}), '') is not null`, unlinkedAmount),
      ),
    )
    .orderBy(asc(registrations.eventId), asc(registrations.id));

  const plan: SponsorshipCodeRepairPlan = { links: [], decisions: [], alreadyLinked: 0 };
  const codes = new Map<string, { eventId: string; code: string }>();
  const withoutCode = new Map<string, string[]>();
  for (const row of candidates) {
    const code = normalizeSponsorshipCode(row.sponsorshipCode);
    if (code) codes.set(`${row.eventId}\u0000${code}`, { eventId: row.eventId, code });
    else withoutCode.set(row.eventId, [...(withoutCode.get(row.eventId) ?? []), row.id]);
  }
  for (const [eventId, ids] of withoutCode) {
    plan.decisions.push({
      reason: "AMOUNT_WITHOUT_CODE",
      eventId,
      code: null,
      sponsorshipId: null,
      registrationIds: ascending(ids),
      detail: "sponsorship amount without a usage or a stored code",
    });
  }
  for (const { eventId, code } of codes.values()) {
    const result = await planCode(db, eventId, code);
    if (result.kind === "link") plan.links.push(result.link);
    else if (result.kind === "decision") plan.decisions.push(result.decision);
    else if (result.kind === "linked") plan.alreadyLinked += 1;
  }
  return plan;
}

export type SponsorshipCodeLinkResult =
  | { outcome: "linked"; registrationId: string; paymentStatus: string; sponsorshipAmount: number }
  | {
      outcome: "skipped";
      registrationId: string;
      reason: "STALE" | "CAPACITY_FULL";
      detail: string;
    };

class StaleLinkError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "StaleLinkError";
  }
}

function sameLink(a: SponsorshipCodeLink, b: SponsorshipCodeLink): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Apply one planned link in its own locking transaction: lock the
 * sponsorship, then the registration, re-plan the code from the locked rows
 * and go on only if the fresh plan is exactly `link`. Then usage + USED,
 * settleRegistrationTxn, the capacity drop of any item it filled, audit
 * (Sponsorship LINK_TO_REGISTRATION and Registration
 * DATA_REPAIR_SPONSORSHIP_LINK) and realtime events; no email. Running it
 * again changes nothing (the code is then already linked).
 */
export async function applySponsorshipCodeLink(link: SponsorshipCodeLink): Promise<SponsorshipCodeLinkResult> {
  const skipped = (reason: "STALE" | "CAPACITY_FULL", detail: string): SponsorshipCodeLinkResult => ({
    outcome: "skipped",
    registrationId: link.registrationId,
    reason,
    detail,
  });
  try {
    return await withLockingTxn(async (tx) => {
      if (!(await lockSponsorshipForUpdate(tx, link.sponsorshipId))) throw new StaleLinkError("sponsorship gone");
      if (!(await lockRegistrationForUpdate(tx, link.registrationId))) throw new StaleLinkError("registration gone");
      const fresh = await planCode(tx, link.eventId, link.code);
      if (fresh.kind !== "link" || !sameLink(fresh.link, link)) {
        throw new StaleLinkError(fresh.kind === "decision" ? `now ${fresh.decision.reason}` : `now ${fresh.kind}`);
      }
      const sponsorship = await readLinkableSponsorship(tx, link.sponsorshipId);
      if (!sponsorship) throw new StaleLinkError("sponsorship gone");
      const [reg] = await tx
        .select({ priceBreakdown: registrations.priceBreakdown, clientId: events.clientId })
        .from(registrations)
        .innerJoin(events, eq(registrations.eventId, events.id))
        .where(eq(registrations.id, link.registrationId));
      const coveredAccessIdsBefore = (await findRegistrationUsagesForRecalc(link.registrationId, tx)).flatMap(
        (usage) => usage.sponsorship.coveredAccessIds,
      );

      const usage = await linkSponsorshipUsageTxn(tx, {
        sponsorship,
        registrationId: link.registrationId,
        priceBreakdown: reg.priceBreakdown,
        appliedBy: SPONSORSHIP_CODE_REPAIR_ACTOR,
      });
      const settled = await settleRegistrationTxn(tx, link.registrationId, { coveredAccessIdsBefore });
      if (
        !settled ||
        settled.after.paymentStatus !== link.after.paymentStatus ||
        settled.after.sponsorshipAmount !== link.after.sponsorshipAmount
      ) {
        throw new StaleLinkError("settled differently from the plan");
      }
      await enqueueAccessDrops(tx, link.eventId, settled.paidAccess.incremented, "capacity_reached");

      await insertAuditLog(
        {
          entityType: "Sponsorship",
          entityId: sponsorship.id,
          action: "LINK_TO_REGISTRATION",
          changes: {
            registrationId: { old: null, new: link.registrationId },
            amountApplied: { old: 0, new: usage.amountApplied },
            sponsorshipAmount: { old: link.before.sponsorshipAmount, new: settled.after.sponsorshipAmount },
            ...(sponsorship.status !== "USED" ? { status: { old: sponsorship.status, new: "USED" } } : {}),
          },
          performedBy: SPONSORSHIP_CODE_REPAIR_ACTOR,
        },
        tx,
      );
      await insertAuditLog(
        {
          entityType: "Registration",
          entityId: link.registrationId,
          action: "DATA_REPAIR_SPONSORSHIP_LINK",
          changes: {
            sponsorshipCode: { old: link.code, new: link.code },
            sponsorshipAmount: { old: link.before.sponsorshipAmount, new: settled.after.sponsorshipAmount },
            paymentStatus: { old: link.before.paymentStatus, new: settled.after.paymentStatus },
          },
          performedBy: SPONSORSHIP_CODE_REPAIR_ACTOR,
        },
        tx,
      );
      const moved = [...settled.paidAccess.incremented, ...settled.paidAccess.decremented];
      const pending: AppEvent[] = [
        ...settlementEventPair({
          id: link.registrationId,
          eventId: link.eventId,
          clientId: reg.clientId,
          oldStatus: link.before.paymentStatus,
          newStatus: settled.after.paymentStatus,
          emitCountsChanged: moved.length > 0,
          accessIds: ascending(moved),
        }),
        {
          type: "sponsorship.linked",
          clientId: reg.clientId,
          eventId: link.eventId,
          payload: { id: sponsorship.id, registrationId: link.registrationId },
          ts: Date.now(),
        },
      ];
      await emitSettlementEvents(tx, pending);
      return {
        outcome: "linked" as const,
        registrationId: link.registrationId,
        paymentStatus: settled.after.paymentStatus,
        sponsorshipAmount: settled.after.sponsorshipAmount,
      };
    });
  } catch (err) {
    if (err instanceof StaleLinkError) return skipped("STALE", err.message);
    if (err instanceof AccessCapacityExceededError) return skipped("CAPACITY_FULL", err.message);
    throw err;
  }
}

export type SponsorshipCodeClearResult =
  | {
      /** `would_clear` on a dry run: the change was computed, then rolled back. */
      outcome: "cleared" | "would_clear";
      registrationId: string;
      /** The stored code, as it was. */
      code: string;
      before: { paymentStatus: string; sponsorshipAmount: number };
      after: { paymentStatus: string; sponsorshipAmount: number; amountDue: number };
    }
  | {
      outcome: "skipped";
      registrationId: string;
      reason: "NOT_FOUND" | "NO_CODE" | "LINKED" | "SETTLED";
      detail: string;
    };

class SkipClear extends Error {
  constructor(
    readonly reason: "NOT_FOUND" | "NO_CODE" | "LINKED" | "SETTLED",
    detail: string,
  ) {
    super(detail);
    this.name = "SkipClear";
  }
}

class DryRunRollback extends Error {
  constructor(readonly result: SponsorshipCodeClearResult) {
    super("dry run");
    this.name = "DryRunRollback";
  }
}

/**
 * Clear one registration's stored signup code: for an unknown code, or a
 * claimant that loses a shared code. In one locking transaction (the code's
 * sponsorship, if any, then the registration): refuse when the code's
 * sponsorship is linked to this registration (use the admin unlink), clear
 * `sponsorship_code` and that code's breakdown line, and settle; without a
 * linked usage the signup amount priced from the code goes to 0 and the
 * status is derived again. A PAID registration whose amount would change is
 * refused. Audited as DATA_REPAIR_CLEAR_SPONSORSHIP_CODE; no email.
 *
 * Without `apply` nothing is kept: the same transaction runs and is rolled
 * back, and the result says what it would do. Never run automatically:
 * the operator names each registration.
 */
export async function clearRegistrationSponsorshipCode(
  registrationId: string,
  options: { apply: boolean },
): Promise<SponsorshipCodeClearResult> {
  try {
    return await withLockingTxn(async (tx) => {
      const [pre] = await tx
        .select({ eventId: registrations.eventId, sponsorshipCode: registrations.sponsorshipCode })
        .from(registrations)
        .where(eq(registrations.id, registrationId))
        .limit(1);
      if (!pre) throw new SkipClear("NOT_FOUND", "no such registration");
      const code = normalizeSponsorshipCode(pre.sponsorshipCode);
      if (!code) throw new SkipClear("NO_CODE", "no stored sponsorship code");
      const sponsorshipId = await findSponsorshipIdByCode(tx, pre.eventId, code);
      if (sponsorshipId) await lockSponsorshipForUpdate(tx, sponsorshipId);
      if (!(await lockRegistrationForUpdate(tx, registrationId))) throw new SkipClear("NOT_FOUND", "no such registration");
      const [reg] = await tx
        .select({
          clientId: events.clientId,
          sponsorshipCode: registrations.sponsorshipCode,
          totalAmount: registrations.totalAmount,
          priceBreakdown: registrations.priceBreakdown,
        })
        .from(registrations)
        .innerJoin(events, eq(registrations.eventId, events.id))
        .where(eq(registrations.id, registrationId));
      if (normalizeSponsorshipCode(reg.sponsorshipCode) !== code) {
        throw new SkipClear("NO_CODE", "the stored code changed; plan again");
      }
      if (sponsorshipId && (await linkedRegistrationIds(tx, sponsorshipId)).includes(registrationId)) {
        throw new SkipClear("LINKED", "the code's sponsorship is linked to this registration; unlink it instead");
      }

      const pb = reg.priceBreakdown;
      const lines = pb?.sponsorships ?? [];
      const keptLines = lines.filter((line) => normalizeSponsorshipCode(line.code) !== code);
      const settled = await settleRegistrationTxn(tx, registrationId, {
        ...(pb && keptLines.length !== lines.length
          ? { priceBreakdown: { ...pb, sponsorships: keptLines }, totalAmount: reg.totalAmount }
          : {}),
        keepUnlinkedSponsorship: false,
        decide: ({ before, sponsorship }) => {
          if (before.paymentStatus === "PAID" && sponsorship !== before.sponsorshipAmount) {
            throw new SkipClear("SETTLED", `PAID: sponsorship ${before.sponsorshipAmount} → ${sponsorship}`);
          }
          return undefined;
        },
        fields: { sponsorshipCode: null },
      });
      if (!settled) throw new SkipClear("NOT_FOUND", "no such registration");
      const { before, after } = settled;

      await insertAuditLog(
        {
          entityType: "Registration",
          entityId: registrationId,
          action: "DATA_REPAIR_CLEAR_SPONSORSHIP_CODE",
          changes: {
            sponsorshipCode: { old: reg.sponsorshipCode, new: null },
            ...(before.sponsorshipAmount !== after.sponsorshipAmount
              ? { sponsorshipAmount: { old: before.sponsorshipAmount, new: after.sponsorshipAmount } }
              : {}),
            ...(before.paymentStatus !== after.paymentStatus
              ? { paymentStatus: { old: before.paymentStatus, new: after.paymentStatus } }
              : {}),
          },
          performedBy: SPONSORSHIP_CODE_REPAIR_ACTOR,
        },
        tx,
      );
      await enqueueAccessDrops(tx, pre.eventId, settled.paidAccess.incremented, "capacity_reached");
      const moved = [...settled.paidAccess.incremented, ...settled.paidAccess.decremented];
      await emitSettlementEvents(
        tx,
        settlementEventPair({
          id: registrationId,
          eventId: pre.eventId,
          clientId: reg.clientId,
          oldStatus: before.paymentStatus,
          newStatus: after.paymentStatus,
          emitCountsChanged: moved.length > 0,
          accessIds: ascending(moved),
        }),
      );
      const result: SponsorshipCodeClearResult = {
        outcome: options.apply ? "cleared" : "would_clear",
        registrationId,
        code: reg.sponsorshipCode ?? code,
        before: { paymentStatus: before.paymentStatus, sponsorshipAmount: before.sponsorshipAmount },
        after: {
          paymentStatus: after.paymentStatus,
          sponsorshipAmount: after.sponsorshipAmount,
          amountDue: Math.max(0, after.totalAmount - after.sponsorshipAmount - after.paidAmount),
        },
      };
      if (!options.apply) throw new DryRunRollback(result);
      return result;
    });
  } catch (err) {
    if (err instanceof DryRunRollback) return err.result;
    if (err instanceof SkipClear) return { outcome: "skipped", registrationId, reason: err.reason, detail: err.message };
    throw err;
  }
}
