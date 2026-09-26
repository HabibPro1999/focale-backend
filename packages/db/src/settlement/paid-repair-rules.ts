import { PAYMENT_STATUSES } from "@app/shared";

// Pure rules of the PAID data repair (plan 2.4): which registrations are
// candidates and why (rebuilt from the audit log), which actions each
// section allows, and the action manifest the dry run writes and --apply
// reads back. No database access here; paid-repair.ts runs the queries.
//
// Sections:
// - A: PAID with paid_amount < net. The main cause: PAID set without an
//   amount stored paid_amount 0 (fixed by 2.1). BACKFILL_PAID is proposed
//   unless an audited action recorded exactly this amount (a
//   deliberate smaller amount) or the price changed after the registration
//   became PAID; those rows get no proposal (per-row decision).
// - B1: PAID demoted by an admin edit's re-pricing: an admin UPDATE audit
//   with a price change moved the status PAID → PENDING/PARTIAL.
// - B2: PAID demoted by a public self-edit. Self-edits never audited the
//   status, so the history is rebuilt: the last audited status is PAID, the
//   row is PENDING/PARTIAL now, and a self-edit (PUBLIC UPDATE audit or
//   last_edited_at) came after it.
// - B3: admin-created rows (whose initial status was never audited)
//   re-priced after --since and PENDING/PARTIAL now: manual review.
// Section C (seat impact) is computed by the planner from these rows.

export const PAID_REPAIR_ACTIONS = ["BACKFILL_PAID", "CONVERT_PARTIAL", "REPROMOTE_PAID", "SKIP"] as const;
export type PaidRepairAction = (typeof PAID_REPAIR_ACTIONS)[number];

export const PAID_REPAIR_SECTIONS = ["A", "B1", "B2", "B3"] as const;
export type PaidRepairSection = (typeof PAID_REPAIR_SECTIONS)[number];

export const PAID_REPAIR_MANIFEST_KIND = "focale.repair-paid-settlement";
export const PAID_REPAIR_MANIFEST_VERSION = 1;

export type PaidRepairFlag =
  /** A: an audited action (payment confirmation or admin edit) recorded exactly this paid amount. */
  | "RECORDED_AMOUNT"
  /** A: the price or the selections changed after the registration became PAID. */
  | "PRICE_CHANGED_AFTER_PAID"
  /** B1: the status changed again, unaudited, after the admin demotion. */
  | "STATUS_CHANGED_SINCE"
  /** B2: nothing after the last audited PAID status shows a self-edit. */
  | "NO_SELF_EDIT_EVIDENCE"
  /** B3: admin-created and no status change was ever audited. */
  | "NO_STATUS_HISTORY"
  /** The stored price breakdown cannot be settled (missing amounts or access items). */
  | "INVALID_BREAKDOWN"
  /** REPROMOTE_PAID would take more paid places than an access item has left. */
  | "CAPACITY_FULL";

/** The row state the approver signed off on; --apply skips the row when it no longer matches. */
export interface PaidRepairExpected {
  paymentStatus: string;
  paidAmount: number;
  /** ISO 8601. */
  updatedAt: string;
}

/** Access paid-count changes by access id (positive = places taken). */
export type SeatDelta = Record<string, number>;

export interface PaidRepairManifestRow {
  /** Registration id. */
  id: string;
  section: PaidRepairSection;
  /** What the dry run suggests; null means no suggestion (decide per row). Never executed as such. */
  proposedAction: PaidRepairAction | null;
  /** The approver's decision. The dry run writes null; --apply refuses a manifest with an unset row. */
  action: PaidRepairAction | null;
  expected: PaidRepairExpected;
  /** Section C: the seats each allowed action would move (SKIP moves none). Informational. */
  seatDelta: Partial<Record<PaidRepairAction, SeatDelta>>;
  /** Informational context for the approver; ignored by --apply. */
  info?: Record<string, unknown>;
}

export interface PaidRepairManifest {
  kind: typeof PAID_REPAIR_MANIFEST_KIND;
  version: typeof PAID_REPAIR_MANIFEST_VERSION;
  generatedAt: string;
  /** --since of the dry run (ISO 8601); --apply re-checks each row's section with it. */
  since: string;
  eventId: string | null;
  rows: PaidRepairManifestRow[];
}

/** A validated manifest row with an approved action. */
export interface ApprovedPaidRepairRow {
  id: string;
  section: PaidRepairSection;
  action: PaidRepairAction;
  expected: PaidRepairExpected;
}

export interface ApprovedPaidRepairManifest {
  since: Date;
  eventId: string | null;
  rows: ApprovedPaidRepairRow[];
}

/**
 * Actions an approver may choose for a row of `section` whose expected
 * status is `paymentStatus`: A rows are PAID (backfill the amount, or
 * convert to PARTIAL); B rows are PENDING/PARTIAL (re-promote to PAID).
 * SKIP is always allowed when the section and status agree.
 */
export function allowedPaidRepairActions(section: PaidRepairSection, paymentStatus: string): PaidRepairAction[] {
  if (section === "A") return paymentStatus === "PAID" ? ["BACKFILL_PAID", "CONVERT_PARTIAL", "SKIP"] : [];
  return paymentStatus === "PENDING" || paymentStatus === "PARTIAL" ? ["REPROMOTE_PAID", "SKIP"] : [];
}

export class PaidRepairManifestError extends Error {
  constructor(readonly problems: string[]) {
    super(`The repair manifest is refused (${problems.length} problem(s)):\n- ${problems.join("\n- ")}`);
    this.name = "PaidRepairManifestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validate an approved manifest (the parsed JSON). Every problem is
 * collected and the whole manifest is refused when there is any, so a
 * partly reviewed or mistyped manifest changes nothing:
 * - kind/version, `since`, and a `rows` array;
 * - each row: a unique id, a known section, an `expected` snapshot (known
 *   status, non-negative integer paid amount, ISO updatedAt);
 * - an action set by the approver (null = not reviewed) that is allowed for
 *   the row's section and expected status.
 * `proposedAction`, `seatDelta` and `info` are informational and not read.
 */
export function parsePaidRepairManifest(input: unknown): ApprovedPaidRepairManifest {
  const problems: string[] = [];
  if (!isRecord(input)) throw new PaidRepairManifestError(["the manifest is not a JSON object"]);
  if (input.kind !== PAID_REPAIR_MANIFEST_KIND) problems.push(`kind must be "${PAID_REPAIR_MANIFEST_KIND}"`);
  if (input.version !== PAID_REPAIR_MANIFEST_VERSION) problems.push(`version must be ${PAID_REPAIR_MANIFEST_VERSION}`);
  if (!isIsoDate(input.since)) problems.push("since must be an ISO date");
  if (input.eventId !== undefined && input.eventId !== null && typeof input.eventId !== "string") {
    problems.push("eventId must be a string or null");
  }
  if (!Array.isArray(input.rows)) {
    problems.push("rows must be an array");
    throw new PaidRepairManifestError(problems);
  }

  const rows: ApprovedPaidRepairRow[] = [];
  const seen = new Set<string>();
  input.rows.forEach((raw: unknown, index: number) => {
    const label = isRecord(raw) && typeof raw.id === "string" && raw.id ? `row ${index} (${raw.id})` : `row ${index}`;
    const rowProblems: string[] = [];
    if (!isRecord(raw)) {
      problems.push(`${label}: not an object`);
      return;
    }
    const id = raw.id;
    if (typeof id !== "string" || id.length === 0) rowProblems.push("id must be a non-empty string");
    else if (seen.has(id)) rowProblems.push("duplicate id");
    else seen.add(id);

    const section = raw.section;
    if (!(PAID_REPAIR_SECTIONS as readonly unknown[]).includes(section)) {
      rowProblems.push(`section must be one of ${PAID_REPAIR_SECTIONS.join(", ")}`);
    }
    const expected = raw.expected;
    if (!isRecord(expected)) {
      rowProblems.push("expected must be an object");
    } else {
      if (!(PAYMENT_STATUSES as readonly unknown[]).includes(expected.paymentStatus)) {
        rowProblems.push("expected.paymentStatus must be a payment status");
      }
      if (!isAmount(expected.paidAmount)) rowProblems.push("expected.paidAmount must be a non-negative integer");
      if (!isIsoDate(expected.updatedAt)) rowProblems.push("expected.updatedAt must be an ISO date");
    }

    const action = raw.action;
    if (action === null || action === undefined) {
      rowProblems.push(`no action: the approver sets one of ${PAID_REPAIR_ACTIONS.join(", ")} (or removes the row)`);
    } else if (!(PAID_REPAIR_ACTIONS as readonly unknown[]).includes(action)) {
      rowProblems.push(`unknown action ${JSON.stringify(action)}`);
    } else if (rowProblems.length === 0) {
      const status = (expected as Record<string, unknown>).paymentStatus as string;
      const allowed = allowedPaidRepairActions(section as PaidRepairSection, status);
      if (!allowed.includes(action as PaidRepairAction)) {
        rowProblems.push(
          `action ${action as string} is not allowed for section ${section as string} with status ${status}` +
            (allowed.length ? ` (allowed: ${allowed.join(", ")})` : " (no action is: section and status disagree)"),
        );
      }
    }

    if (rowProblems.length) {
      for (const problem of rowProblems) problems.push(`${label}: ${problem}`);
      return;
    }
    const exp = expected as Record<string, unknown>;
    rows.push({
      id: id as string,
      section: section as PaidRepairSection,
      action: action as PaidRepairAction,
      expected: {
        paymentStatus: exp.paymentStatus as string,
        paidAmount: exp.paidAmount as number,
        updatedAt: exp.updatedAt as string,
      },
    });
  });

  if (problems.length) throw new PaidRepairManifestError(problems);
  return { since: new Date(input.since as string), eventId: (input.eventId as string | null | undefined) ?? null, rows };
}

// ---------------------------------------------------------------------------
// Candidate classification (status history rebuilt from the audit log)
// ---------------------------------------------------------------------------

/** One audit_logs row of the registration (entity_type Registration). */
export interface RepairAuditEntry {
  id: string;
  action: string;
  performedBy: string | null;
  performedAt: Date;
  changes: unknown;
}

/** The registration columns the classification reads. */
export interface RepairRegistrationFacts {
  paymentStatus: string;
  paidAmount: number;
  totalAmount: number;
  sponsorshipAmount: number;
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lastEditedAt: Date | null;
}

export interface PaidRepairClassification {
  section: PaidRepairSection;
  proposedAction: PaidRepairAction | null;
  flags: PaidRepairFlag[];
  /**
   * The paid_at a PAID action writes: the stored one for A when set, else
   * the time the audit shows the registration became PAID (or was created).
   */
  paidAt: Date;
  /** Audit ids the classification rests on. */
  evidence: string[];
  detail: string;
}

interface StatusChange {
  entry: RepairAuditEntry;
  old: string | null;
  new: string;
}

function change(entry: RepairAuditEntry, field: string): { old: unknown; new: unknown } | null {
  const changes = entry.changes;
  if (!isRecord(changes)) return null;
  const value = changes[field];
  return isRecord(value) && "new" in value ? { old: value.old, new: value.new } : null;
}

function statusChangeOf(entry: RepairAuditEntry): StatusChange | null {
  const status = change(entry, "paymentStatus");
  if (!status || typeof status.new !== "string") return null;
  return { entry, old: typeof status.old === "string" ? status.old : null, new: status.new };
}

function isPublic(entry: RepairAuditEntry): boolean {
  return entry.performedBy === "PUBLIC";
}

/** An admin user's action: neither the public form nor the system. */
function isAdmin(entry: RepairAuditEntry): boolean {
  const by = entry.performedBy;
  return !!by && by !== "PUBLIC" && by !== "SYSTEM" && !by.startsWith("SYSTEM:");
}

function isSelfEdit(entry: RepairAuditEntry): boolean {
  return entry.action === "UPDATE" && isPublic(entry);
}

/** The admin edit's price path always audited totalAmount (legacy and 2.6c). */
function isAdminRepricing(entry: RepairAuditEntry): boolean {
  return entry.action === "UPDATE" && isAdmin(entry) && change(entry, "totalAmount") !== null;
}

/** The entry changed, or may have changed, the price. */
function changesPrice(entry: RepairAuditEntry): boolean {
  const total = change(entry, "totalAmount");
  if (total && total.old !== total.new) return true;
  if (change(entry, "accessSelections")) return true;
  return isSelfEdit(entry) && change(entry, "formData") !== null;
}

function after(entry: RepairAuditEntry, time: Date): boolean {
  return entry.performedAt.getTime() > time.getTime();
}

function atOrAfter(time: Date | null | undefined, since: Date): boolean {
  return !!time && time.getTime() >= since.getTime();
}

function ordered(entries: readonly RepairAuditEntry[]): RepairAuditEntry[] {
  return [...entries].sort(
    (a, b) => a.performedAt.getTime() - b.performedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** The registration's net: gross − sponsorship, floored at 0. */
export function netOf(reg: Pick<RepairRegistrationFacts, "totalAmount" | "sponsorshipAmount">): number {
  return Math.max(0, reg.totalAmount - reg.sponsorshipAmount);
}

/**
 * Classify one registration from its row and its Registration audit
 * entries (any order). Returns null when it is not a repair candidate.
 * `since` is the Nest deploy: B sections only consider demotions and
 * re-pricing from then on; A is state-based (any PAID row with paid < net).
 */
export function classifyPaidRepairCandidate(
  reg: RepairRegistrationFacts,
  audits: readonly RepairAuditEntry[],
  since: Date,
): PaidRepairClassification | null {
  const entries = ordered(audits);
  const statusChanges = entries.map(statusChangeOf).filter((c): c is StatusChange => c !== null);
  const created = entries.find((entry) => entry.action === "CREATE");
  const creationTime = created?.performedAt ?? reg.createdAt;
  const net = netOf(reg);

  if (reg.paymentStatus === "PAID") {
    if (reg.paidAmount >= net) return null;
    const paidChange = statusChanges.filter((c) => c.new === "PAID").at(-1);
    const fromPaid = paidChange ? entries.slice(entries.indexOf(paidChange.entry)) : entries;
    const flags: PaidRepairFlag[] = [];
    const evidence: string[] = paidChange ? [paidChange.entry.id] : [];
    // Any audited amount counts (a confirmation may carry no actor id).
    const amountEntry = fromPaid.filter((entry) => typeof change(entry, "paidAmount")?.new === "number").at(-1);
    if (amountEntry && change(amountEntry, "paidAmount")!.new === reg.paidAmount) {
      flags.push("RECORDED_AMOUNT");
      if (!evidence.includes(amountEntry.id)) evidence.push(amountEntry.id);
    }
    const repriced = fromPaid.filter((entry) => entry !== paidChange?.entry && entry !== created && changesPrice(entry));
    if (repriced.length) {
      flags.push("PRICE_CHANGED_AFTER_PAID");
      evidence.push(...repriced.map((entry) => entry.id));
    }
    const how = paidChange
      ? `PAID by ${paidChange.entry.action} at ${paidChange.entry.performedAt.toISOString()}`
      : "no audited PAID status (admin create or pre-audit)";
    return {
      section: "A",
      proposedAction: flags.length ? null : "BACKFILL_PAID",
      flags,
      paidAt: reg.paidAt ?? paidChange?.entry.performedAt ?? creationTime,
      evidence,
      detail: `paid ${reg.paidAmount} < net ${net}; ${how}`,
    };
  }

  if (reg.paymentStatus !== "PENDING" && reg.paymentStatus !== "PARTIAL") return null;
  if (net === 0 || reg.paidAmount >= net || !atOrAfter(reg.updatedAt, since)) return null;
  const last = statusChanges.at(-1);

  // B2: the last audited status is PAID, yet the row is not: an unaudited
  // change, which is what a public self-edit's re-pricing did.
  if (last?.new === "PAID") {
    const paidTime = last.entry.performedAt;
    const selfEdits = entries.filter((entry) => isSelfEdit(entry) && after(entry, paidTime));
    const editedAfter = !!reg.lastEditedAt && reg.lastEditedAt.getTime() > paidTime.getTime();
    const evidence = [last.entry.id, ...selfEdits.map((entry) => entry.id)];
    if (selfEdits.length === 0 && !editedAfter) {
      return {
        section: "B2",
        proposedAction: null,
        flags: ["NO_SELF_EDIT_EVIDENCE"],
        paidAt: paidTime,
        evidence,
        detail: `last audited status PAID (${last.entry.action} at ${paidTime.toISOString()}), now ${reg.paymentStatus}; no self-edit after it`,
      };
    }
    const inWindow =
      selfEdits.some((entry) => atOrAfter(entry.performedAt, since)) || (editedAfter && atOrAfter(reg.lastEditedAt, since));
    if (!inWindow) return null;
    return {
      section: "B2",
      proposedAction: "REPROMOTE_PAID",
      flags: [],
      paidAt: paidTime,
      evidence,
      detail: `last audited status PAID (${last.entry.action} at ${paidTime.toISOString()}), now ${reg.paymentStatus} after a self-edit`,
    };
  }

  // B1: an admin edit's re-pricing demoted PAID (the change is audited with
  // the price). An explicit status change without re-pricing is deliberate.
  if (
    last &&
    last.old === "PAID" &&
    (last.new === "PENDING" || last.new === "PARTIAL") &&
    isAdminRepricing(last.entry) &&
    atOrAfter(last.entry.performedAt, since)
  ) {
    const flags: PaidRepairFlag[] = reg.paymentStatus !== last.new ? ["STATUS_CHANGED_SINCE"] : [];
    const paidBefore = statusChanges.filter((c) => c.new === "PAID" && c.entry.performedAt <= last.entry.performedAt && c !== last).at(-1);
    return {
      section: "B1",
      proposedAction: flags.length ? null : "REPROMOTE_PAID",
      flags,
      paidAt: paidBefore?.entry.performedAt ?? creationTime,
      evidence: [last.entry.id, ...(paidBefore ? [paidBefore.entry.id] : [])],
      detail: `admin edit at ${last.entry.performedAt.toISOString()} re-priced and moved PAID → ${last.new}; now ${reg.paymentStatus}`,
    };
  }

  // B3: created by an admin with a status the audit never recorded, then
  // re-priced in the window: it may have been PAID; nobody can tell.
  if (statusChanges.length === 0 && created && isAdmin(created)) {
    const repriced = entries.filter(
      (entry) => entry !== created && atOrAfter(entry.performedAt, since) && (isAdminRepricing(entry) || isSelfEdit(entry)),
    );
    if (repriced.length === 0 && !atOrAfter(reg.lastEditedAt, since)) return null;
    return {
      section: "B3",
      proposedAction: null,
      flags: ["NO_STATUS_HISTORY"],
      paidAt: created.performedAt,
      evidence: [created.id, ...repriced.map((entry) => entry.id)],
      detail: `admin-created at ${created.performedAt.toISOString()} (status not audited), re-priced since ${since.toISOString()}; now ${reg.paymentStatus}`,
    };
  }
  return null;
}
