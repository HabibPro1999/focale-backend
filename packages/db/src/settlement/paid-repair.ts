import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { AppEvent, PriceBreakdown } from "@app/contracts";
import { paidAccessQuantities } from "@app/shared";
import { getDb, type DbExecutor } from "../client";
import { lockRegistrationForUpdate } from "../locks";
import { insertAuditLog } from "../outbox";
import { findRegistrationUsagesForRecalc } from "../queries/registrations";
import { eventAccess, events } from "../schema/events-access";
import { auditLogs } from "../schema/outbox-audit";
import { registrations } from "../schema/registrations";
import { withLockingTxn } from "../txn";
import { enqueueAccessDrops } from "./access-drop";
import { emitSettlementEvents } from "./events";
import { AccessCapacityExceededError, AccessNotFoundError } from "./paid-access";
import {
  PAID_REPAIR_MANIFEST_KIND,
  PAID_REPAIR_MANIFEST_VERSION,
  allowedPaidRepairActions,
  classifyPaidRepairCandidate,
  netOf,
  type ApprovedPaidRepairRow,
  type PaidRepairAction,
  type PaidRepairClassification,
  type PaidRepairExpected,
  type PaidRepairFlag,
  type PaidRepairManifest,
  type PaidRepairSection,
  type RepairAuditEntry,
  type RepairRegistrationFacts,
  type SeatDelta,
} from "./paid-repair-rules";
import { settleRegistrationTxn } from "./settle";

// PAID data repair (plan 2.4). The dry run (planPaidSettlementRepair) is
// read-only: it lists the candidates of sections A/B1/B2/B3 (see
// paid-repair-rules.ts) with the seats each action would move (section C),
// and buildPaidRepairManifest turns it into the manifest an approver fills
// in. applyPaidRepairRow executes one approved row in its own locking
// transaction: lock → re-read → the row must still match the approved
// snapshot and still be a candidate of its section → settleRegistrationTxn
// with an explicit status and amount, so access seats move only by the
// writer's old → new delta. Every applied row is audited
// DATA_REPAIR_SETTLEMENT and enqueues registration.updated; no email.
// Running a manifest again changes nothing.

export const PAID_REPAIR_ACTOR = "SYSTEM:repair-paid-settlement";
export const DATA_REPAIR_SETTLEMENT_AUDIT_ACTION = "DATA_REPAIR_SETTLEMENT";

export interface PaidRepairCandidate {
  id: string;
  eventId: string;
  referenceNumber: string | null;
  section: PaidRepairSection;
  proposedAction: PaidRepairAction | null;
  flags: PaidRepairFlag[];
  detail: string;
  /** Audit entries the section rests on. */
  evidence: string[];
  expected: PaidRepairExpected;
  totalAmount: number;
  sponsorshipAmount: number;
  net: number;
  paidAt: string | null;
  /** The paid_at a PAID action would write. */
  proposedPaidAt: string;
  /** Seats each allowed non-SKIP action would move. */
  seatDelta: Partial<Record<PaidRepairAction, SeatDelta>>;
}

/** Section C, per access item: current paid places and the proposed actions' total delta. */
export interface PaidRepairSeatImpact {
  accessId: string;
  eventId: string | null;
  name: string | null;
  maxCapacity: number | null;
  paidCount: number | null;
  proposedDelta: number;
  /** paidCount + proposedDelta would exceed maxCapacity: some re-promotions will be skipped. */
  overCapacity: boolean;
  registrationIds: string[];
}

export interface PaidRepairReport {
  since: string;
  generatedAt: string;
  eventId: string | null;
  candidates: PaidRepairCandidate[];
  seatImpact: PaidRepairSeatImpact[];
}

const factColumns = {
  id: registrations.id,
  eventId: registrations.eventId,
  referenceNumber: registrations.referenceNumber,
  paymentStatus: registrations.paymentStatus,
  paidAmount: registrations.paidAmount,
  totalAmount: registrations.totalAmount,
  sponsorshipAmount: registrations.sponsorshipAmount,
  paidAt: registrations.paidAt,
  createdAt: registrations.createdAt,
  updatedAt: registrations.updatedAt,
  lastEditedAt: registrations.lastEditedAt,
  priceBreakdown: registrations.priceBreakdown,
};

type FactRow = RepairRegistrationFacts & {
  id: string;
  eventId: string;
  referenceNumber: string | null;
  priceBreakdown: unknown;
};

const AUDIT_CHUNK = 500;

async function registrationAudits(db: DbExecutor, ids: string[]): Promise<Map<string, RepairAuditEntry[]>> {
  const byId = new Map<string, RepairAuditEntry[]>();
  for (let i = 0; i < ids.length; i += AUDIT_CHUNK) {
    const rows = await db
      .select({
        id: auditLogs.id,
        entityId: auditLogs.entityId,
        action: auditLogs.action,
        performedBy: auditLogs.performedBy,
        performedAt: auditLogs.performedAt,
        changes: auditLogs.changes,
      })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, "Registration"), inArray(auditLogs.entityId, ids.slice(i, i + AUDIT_CHUNK))))
      .orderBy(asc(auditLogs.performedAt), asc(auditLogs.id));
    for (const { entityId, ...entry } of rows) byId.set(entityId, [...(byId.get(entityId) ?? []), entry]);
  }
  return byId;
}

function isSettleableBreakdown(value: unknown): value is PriceBreakdown {
  const pb = value as Partial<PriceBreakdown> | null;
  return (
    !!pb &&
    Number.isSafeInteger(pb.subtotal) &&
    Number.isSafeInteger(pb.calculatedBasePrice) &&
    Array.isArray(pb.accessItems) &&
    pb.accessItems.every(
      (item) => typeof item?.accessId === "string" && Number.isSafeInteger(item.quantity) && Number.isSafeInteger(item.subtotal),
    )
  );
}

/** Target status of an action; null for SKIP. */
function targetStatus(action: PaidRepairAction): string | null {
  if (action === "BACKFILL_PAID" || action === "REPROMOTE_PAID") return "PAID";
  return action === "CONVERT_PARTIAL" ? "PARTIAL" : null;
}

function seatDeltaOf(before: string, after: string, breakdown: PriceBreakdown, covered: Set<string>): SeatDelta {
  const oldPaid = paidAccessQuantities(before, breakdown, covered);
  const newPaid = paidAccessQuantities(after, breakdown, covered);
  const delta: SeatDelta = {};
  for (const accessId of [...new Set([...oldPaid.keys(), ...newPaid.keys()])].sort()) {
    const moved = (newPaid.get(accessId) ?? 0) - (oldPaid.get(accessId) ?? 0);
    if (moved !== 0) delta[accessId] = moved;
  }
  return delta;
}

/**
 * Read-only dry run: the candidates of sections A (every PAID row with
 * paid < net) and B1/B2/B3 (PENDING/PARTIAL rows updated since `since`,
 * classified from their audit history), with the seats each allowed action
 * would move and, per access item, the proposed actions' total (section C).
 */
export async function planPaidSettlementRepair(
  options: { since: Date; eventId?: string; now?: Date },
  db: DbExecutor = getDb(),
): Promise<PaidRepairReport> {
  const { since } = options;
  if (Number.isNaN(since.getTime())) throw new Error("since must be a valid date");
  const eventFilter = options.eventId ? eq(registrations.eventId, options.eventId) : undefined;
  const net = sql`greatest(0, ${registrations.totalAmount} - ${registrations.sponsorshipAmount})`;
  const underpaidPaid = await db
    .select(factColumns)
    .from(registrations)
    .where(and(eventFilter, eq(registrations.paymentStatus, "PAID"), lt(registrations.paidAmount, net)))
    .orderBy(asc(registrations.eventId), asc(registrations.id));
  const demotable = await db
    .select(factColumns)
    .from(registrations)
    .where(
      and(
        eventFilter,
        inArray(registrations.paymentStatus, ["PENDING", "PARTIAL"]),
        gte(registrations.updatedAt, since),
        lt(registrations.paidAmount, net),
      ),
    )
    .orderBy(asc(registrations.eventId), asc(registrations.id));
  const rows: FactRow[] = [...underpaidPaid, ...demotable];
  const audits = await registrationAudits(db, rows.map((row) => row.id));

  const classified: Array<{ row: FactRow; classification: PaidRepairClassification }> = [];
  for (const row of rows) {
    const classification = classifyPaidRepairCandidate(row, audits.get(row.id) ?? [], since);
    if (classification) classified.push({ row, classification });
  }

  const candidates: PaidRepairCandidate[] = [];
  for (const { row, classification } of classified) {
    const flags = [...classification.flags];
    const seatDelta: Partial<Record<PaidRepairAction, SeatDelta>> = {};
    let proposedAction = classification.proposedAction;
    if (isSettleableBreakdown(row.priceBreakdown)) {
      const covered = new Set(
        (await findRegistrationUsagesForRecalc(row.id, db)).flatMap((usage) => usage.sponsorship.coveredAccessIds),
      );
      for (const action of allowedPaidRepairActions(classification.section, row.paymentStatus)) {
        const target = targetStatus(action);
        if (target) seatDelta[action] = seatDeltaOf(row.paymentStatus, target, row.priceBreakdown, covered);
      }
    } else {
      flags.push("INVALID_BREAKDOWN");
      proposedAction = null;
    }
    candidates.push({
      id: row.id,
      eventId: row.eventId,
      referenceNumber: row.referenceNumber,
      section: classification.section,
      proposedAction,
      flags,
      detail: classification.detail,
      evidence: classification.evidence,
      expected: { paymentStatus: row.paymentStatus, paidAmount: row.paidAmount, updatedAt: row.updatedAt.toISOString() },
      totalAmount: row.totalAmount,
      sponsorshipAmount: row.sponsorshipAmount,
      net: netOf(row),
      paidAt: row.paidAt?.toISOString() ?? null,
      proposedPaidAt: classification.paidAt.toISOString(),
      seatDelta,
    });
  }

  // Section C: current capacity of every item an action would move.
  const accessIds = [...new Set(candidates.flatMap((c) => Object.values(c.seatDelta).flatMap((d) => Object.keys(d ?? {}))))].sort();
  const accessRows = accessIds.length
    ? await db
        .select({
          id: eventAccess.id,
          eventId: eventAccess.eventId,
          name: eventAccess.name,
          maxCapacity: eventAccess.maxCapacity,
          paidCount: eventAccess.paidCount,
        })
        .from(eventAccess)
        .where(inArray(eventAccess.id, accessIds))
    : [];
  const access = new Map(accessRows.map((row) => [row.id, row]));
  for (const candidate of candidates) {
    const repromote = candidate.seatDelta.REPROMOTE_PAID ?? {};
    const full = Object.entries(repromote).some(([accessId, delta]) => {
      const item = access.get(accessId);
      return delta > 0 && (!item || (item.maxCapacity !== null && item.paidCount + delta > item.maxCapacity));
    });
    if (full) candidate.flags.push("CAPACITY_FULL");
  }
  const impact = new Map<string, PaidRepairSeatImpact>();
  for (const candidate of candidates) {
    const delta = candidate.proposedAction ? candidate.seatDelta[candidate.proposedAction] : undefined;
    for (const [accessId, moved] of Object.entries(delta ?? {})) {
      const item = access.get(accessId);
      const entry = impact.get(accessId) ?? {
        accessId,
        eventId: item?.eventId ?? null,
        name: item?.name ?? null,
        maxCapacity: item?.maxCapacity ?? null,
        paidCount: item?.paidCount ?? null,
        proposedDelta: 0,
        overCapacity: false,
        registrationIds: [],
      };
      entry.proposedDelta += moved;
      entry.registrationIds.push(candidate.id);
      impact.set(accessId, entry);
    }
  }
  const seatImpact = [...impact.values()]
    .map((entry) => ({
      ...entry,
      overCapacity:
        entry.paidCount === null ||
        (entry.maxCapacity !== null && entry.paidCount + entry.proposedDelta > entry.maxCapacity),
    }))
    .sort((a, b) => (a.accessId < b.accessId ? -1 : 1));

  return {
    since: since.toISOString(),
    generatedAt: (options.now ?? new Date()).toISOString(),
    eventId: options.eventId ?? null,
    candidates,
    seatImpact,
  };
}

/** The manifest the approver fills in: one row per candidate, every action unset. */
export function buildPaidRepairManifest(report: PaidRepairReport): PaidRepairManifest {
  return {
    kind: PAID_REPAIR_MANIFEST_KIND,
    version: PAID_REPAIR_MANIFEST_VERSION,
    generatedAt: report.generatedAt,
    since: report.since,
    eventId: report.eventId,
    rows: report.candidates.map((candidate) => ({
      id: candidate.id,
      section: candidate.section,
      proposedAction: candidate.proposedAction,
      action: null,
      expected: candidate.expected,
      seatDelta: candidate.seatDelta,
      info: {
        eventId: candidate.eventId,
        referenceNumber: candidate.referenceNumber,
        flags: candidate.flags,
        detail: candidate.detail,
        totalAmount: candidate.totalAmount,
        sponsorshipAmount: candidate.sponsorshipAmount,
        net: candidate.net,
        paidAt: candidate.paidAt,
        proposedPaidAt: candidate.proposedPaidAt,
        evidence: candidate.evidence,
      },
    })),
  };
}

export type PaidRepairSkipReason =
  /** The approver chose SKIP: the row is not read or written. */
  | "SKIP"
  /** A DATA_REPAIR_SETTLEMENT with this action was already applied to the row. */
  | "ALREADY_APPLIED"
  | "NOT_FOUND"
  /** The row no longer matches the approved snapshot (status, paid amount, updated_at). */
  | "STALE"
  /** The row is no longer a candidate of its section (fresh audit history). */
  | "NOT_A_CANDIDATE"
  /** The action does not fit the row's amounts (e.g. nothing left to backfill). */
  | "NOT_APPLICABLE"
  /** The stored breakdown or sponsorship disagrees with the recomputed one: fix it first (invariant report). */
  | "BREAKDOWN_MISMATCH"
  /** An access item has no paid place left for the re-promotion. */
  | "CAPACITY_FULL"
  | "ACCESS_NOT_FOUND";

export type PaidRepairResult =
  | {
      outcome: "applied";
      id: string;
      action: PaidRepairAction;
      before: { paymentStatus: string; paidAmount: number; paidAt: string | null };
      after: { paymentStatus: string; paidAmount: number; paidAt: string | null };
      /** Paid places moved by the settlement writer. */
      seatsMoved: { incremented: string[]; decremented: string[] };
    }
  | { outcome: "skipped"; id: string; action: PaidRepairAction; reason: PaidRepairSkipReason; detail: string };

class SkipRepair extends Error {
  constructor(
    readonly reason: PaidRepairSkipReason,
    detail: string,
  ) {
    super(detail);
    this.name = "SkipRepair";
  }
}

async function alreadyApplied(tx: DbExecutor, id: string, action: PaidRepairAction): Promise<boolean> {
  const rows = await tx
    .select({ changes: auditLogs.changes })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.entityType, "Registration"),
        eq(auditLogs.entityId, id),
        eq(auditLogs.action, DATA_REPAIR_SETTLEMENT_AUDIT_ACTION),
      ),
    )
    .orderBy(desc(auditLogs.performedAt));
  return rows.some((row) => (row.changes as { repairAction?: { new?: unknown } } | null)?.repairAction?.new === action);
}

function isoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Execute one approved manifest row in its own locking transaction (see the
 * file header). SKIP rows are not read. `since` is the manifest's: the row
 * must still be a candidate of its section under the fresh audit history.
 * Skips roll back everything; seats move only by the settlement writer's
 * delta; a re-promotion that fills an item enqueues its capacity drop.
 */
export async function applyPaidRepairRow(row: ApprovedPaidRepairRow, options: { since: Date }): Promise<PaidRepairResult> {
  const { id, action } = row;
  const skipped = (reason: PaidRepairSkipReason, detail: string): PaidRepairResult => ({
    outcome: "skipped",
    id,
    action,
    reason,
    detail,
  });
  if (action === "SKIP") return skipped("SKIP", "approved as SKIP");
  try {
    return await withLockingTxn(async (tx) => {
      if (!(await lockRegistrationForUpdate(tx, id))) throw new SkipRepair("NOT_FOUND", "no such registration");
      const [reg] = await tx
        .select({ ...factColumns, clientId: events.clientId })
        .from(registrations)
        .innerJoin(events, eq(registrations.eventId, events.id))
        .where(eq(registrations.id, id));
      if (!reg) throw new SkipRepair("NOT_FOUND", "no such registration");
      if (await alreadyApplied(tx, id, action)) throw new SkipRepair("ALREADY_APPLIED", `${action} was already applied`);

      const { expected } = row;
      if (
        reg.paymentStatus !== expected.paymentStatus ||
        reg.paidAmount !== expected.paidAmount ||
        reg.updatedAt.getTime() !== new Date(expected.updatedAt).getTime()
      ) {
        throw new SkipRepair(
          "STALE",
          `now ${reg.paymentStatus} paid ${reg.paidAmount} updated ${reg.updatedAt.toISOString()}; ` +
            `approved ${expected.paymentStatus} paid ${expected.paidAmount} updated ${expected.updatedAt}`,
        );
      }
      const audits = await registrationAudits(tx, [id]);
      const fresh = classifyPaidRepairCandidate(reg, audits.get(id) ?? [], options.since);
      if (!fresh || fresh.section !== row.section) {
        throw new SkipRepair("NOT_A_CANDIDATE", fresh ? `now section ${fresh.section}` : "no longer a candidate");
      }
      if (!allowedPaidRepairActions(row.section, reg.paymentStatus).includes(action)) {
        throw new SkipRepair("NOT_APPLICABLE", `${action} does not apply to a ${reg.paymentStatus} row`);
      }
      if (!isSettleableBreakdown(reg.priceBreakdown)) {
        throw new SkipRepair("BREAKDOWN_MISMATCH", "the stored price breakdown cannot be settled");
      }
      const storedBreakdown = reg.priceBreakdown;

      const settled = await settleRegistrationTxn(tx, id, {
        decide: ({ before, gross, sponsorship, net }) => {
          if (
            gross !== before.totalAmount ||
            sponsorship !== before.sponsorshipAmount ||
            storedBreakdown.sponsorshipTotal !== sponsorship ||
            storedBreakdown.total !== Math.max(0, storedBreakdown.subtotal - sponsorship)
          ) {
            throw new SkipRepair(
              "BREAKDOWN_MISMATCH",
              `stored sponsorship ${before.sponsorshipAmount} (breakdown ${storedBreakdown.sponsorshipTotal}, ` +
                `total ${storedBreakdown.total}) vs recomputed ${sponsorship}`,
            );
          }
          if (before.paidAmount >= net) throw new SkipRepair("NOT_APPLICABLE", `paid ${before.paidAmount} ≥ net ${net}`);
          if (action === "CONVERT_PARTIAL") {
            if (before.paidAmount + sponsorship === 0) {
              throw new SkipRepair("NOT_APPLICABLE", "nothing paid or sponsored: PARTIAL needs a covered amount");
            }
            return { paymentStatus: "PARTIAL", paidAt: null };
          }
          const paidAt = action === "BACKFILL_PAID" ? (before.paidAt ?? fresh.paidAt) : fresh.paidAt;
          return { paymentStatus: "PAID", paidAmount: net, paidAt };
        },
      });
      if (!settled) throw new SkipRepair("NOT_FOUND", "no such registration");
      const { before, after, paidAccess } = settled;
      await enqueueAccessDrops(tx, reg.eventId, paidAccess.incremented, "capacity_reached");

      const changes: Record<string, { old: unknown; new: unknown }> = {
        repairAction: { old: null, new: action },
        repairSection: { old: null, new: row.section },
      };
      if (before.paymentStatus !== after.paymentStatus) {
        changes.paymentStatus = { old: before.paymentStatus, new: after.paymentStatus };
      }
      if (before.paidAmount !== after.paidAmount) changes.paidAmount = { old: before.paidAmount, new: after.paidAmount };
      if (isoOrNull(before.paidAt) !== isoOrNull(after.paidAt)) {
        changes.paidAt = { old: isoOrNull(before.paidAt), new: isoOrNull(after.paidAt) };
      }
      await insertAuditLog(
        {
          entityType: "Registration",
          entityId: id,
          action: DATA_REPAIR_SETTLEMENT_AUDIT_ACTION,
          changes,
          performedBy: PAID_REPAIR_ACTOR,
        },
        tx,
      );

      // registration.updated only: never paymentConfirmed, and no email.
      const moved = [...new Set([...paidAccess.incremented, ...paidAccess.decremented])].sort();
      const pending: AppEvent[] = [
        {
          type: "registration.updated",
          clientId: reg.clientId,
          eventId: reg.eventId,
          payload: { id, paymentStatus: after.paymentStatus },
          ts: Date.now(),
        },
      ];
      if (moved.length > 0) {
        pending.push({
          type: "eventAccess.countsChanged",
          clientId: reg.clientId,
          eventId: reg.eventId,
          payload: { id: reg.eventId, accessIds: moved },
          ts: Date.now(),
        });
      }
      await emitSettlementEvents(tx, pending);
      return {
        outcome: "applied" as const,
        id,
        action,
        before: { paymentStatus: before.paymentStatus, paidAmount: before.paidAmount, paidAt: isoOrNull(before.paidAt) },
        after: { paymentStatus: after.paymentStatus, paidAmount: after.paidAmount, paidAt: isoOrNull(after.paidAt) },
        seatsMoved: paidAccess,
      };
    });
  } catch (err) {
    if (err instanceof SkipRepair) return skipped(err.reason, err.message);
    if (err instanceof AccessCapacityExceededError) return skipped("CAPACITY_FULL", err.message);
    if (err instanceof AccessNotFoundError) return skipped("ACCESS_NOT_FOUND", err.message);
    throw err;
  }
}
