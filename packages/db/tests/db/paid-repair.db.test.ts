import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  ACCESS_CAPACITY_REACHED_OUTBOX_TYPE,
  DATA_REPAIR_SETTLEMENT_AUDIT_ACTION,
  PAID_REPAIR_ACTOR,
  PaidRepairManifestError,
  applyPaidRepairRow,
  auditLogs,
  buildPaidRepairManifest,
  checkSettlementInvariants,
  emailLogs,
  eventAccess,
  getDb,
  insertAuditLog,
  outboxEvents,
  parsePaidRepairManifest,
  planPaidSettlementRepair,
  registrations,
  type PaidRepairAction,
  type PaidRepairReport,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import {
  seedEvent,
  seedEventAccess,
  seedForm,
  seedRegistration,
  seedSponsorship,
  seedSponsorshipBatch,
  seedSponsorshipUsage,
} from "../helpers/factories";
import { realtimeRowsOf } from "../helpers/sponsorship-inspect";

// Plan 2.4: PAID data repair. The dry run is read-only and yields a manifest;
// --apply runs each approved row through settleRegistrationTxn with an
// explicit status and amount, so seats move only by the writer's delta.

const DAY = 86_400_000;
const NOW = Date.now();
const SINCE = new Date(NOW - 30 * DAY);
const daysAgo = (days: number) => new Date(NOW - days * DAY);

async function scenario(
  options: { galaCapacity?: number; galaPaid?: number; dinnerCapacity?: number; dinnerPaid?: number } = {},
) {
  const event = await seedEvent({ status: "OPEN" });
  const form = await seedForm({ eventId: event.id });
  const gala = await seedEventAccess({
    eventId: event.id,
    name: "Gala",
    price: 200,
    maxCapacity: options.galaCapacity ?? null,
    paidCount: options.galaPaid ?? 0,
    registeredCount: 5,
  });
  const dinner = await seedEventAccess({
    eventId: event.id,
    name: "Dinner",
    price: 100,
    maxCapacity: options.dinnerCapacity ?? null,
    paidCount: options.dinnerPaid ?? 0,
    registeredCount: 5,
  });
  return { event, form, gala, dinner };
}

type Scenario = Awaited<ReturnType<typeof scenario>>;

/** Base 100 + gala 200 + dinner 100 = 400; a sponsorship covering the gala takes 200 off. */
function breakdown(s: Scenario, sponsorship: number) {
  const accessItems = [
    { accessId: s.gala.id, name: "Gala", unitPrice: 200, quantity: 1, subtotal: 200 },
    { accessId: s.dinner.id, name: "Dinner", unitPrice: 100, quantity: 1, subtotal: 100 },
  ];
  return {
    basePrice: 100,
    appliedRules: [],
    calculatedBasePrice: 100,
    accessItems,
    accessTotal: 300,
    subtotal: 400,
    sponsorships: [],
    sponsorshipTotal: sponsorship,
    total: 400 - sponsorship,
    currency: "TND",
    droppedAccessItems: [],
  };
}

async function seedCandidate(
  s: Scenario,
  values: {
    status: "PAID" | "PARTIAL" | "PENDING";
    paidAmount: number;
    paidAt?: Date | null;
    sponsoredGala?: boolean;
    lastEditedAt?: Date | null;
  },
) {
  const sponsorship = values.sponsoredGala ? 200 : 0;
  const reg = await seedRegistration({
    eventId: s.event.id,
    formId: s.form.id,
    paymentStatus: values.status,
    paidAmount: values.paidAmount,
    paidAt: values.paidAt ?? null,
    totalAmount: 400,
    baseAmount: 100,
    accessAmount: 300,
    sponsorshipAmount: sponsorship,
    priceBreakdown: breakdown(s, sponsorship),
    accessTypeIds: [s.gala.id, s.dinner.id],
    lastEditedAt: values.lastEditedAt ?? null,
  });
  if (values.sponsoredGala) {
    const batch = await seedSponsorshipBatch({ eventId: s.event.id, formId: s.form.id });
    const sp = await seedSponsorship({
      batchId: batch.id,
      eventId: s.event.id,
      status: "USED",
      totalAmount: 200,
      coversBasePrice: false,
      coveredAccessIds: [s.gala.id],
    });
    await seedSponsorshipUsage({ sponsorshipId: sp.id, registrationId: reg.id, amountApplied: 200, appliedBy: "admin-1" });
  }
  return reg;
}

async function audit(
  registrationId: string,
  action: string,
  performedBy: string,
  performedAt: Date,
  changes: Record<string, unknown> = {},
) {
  await insertAuditLog({ entityType: "Registration", entityId: registrationId, action, performedBy, performedAt, changes }, getDb());
}

const status = (from: string, to: string) => ({ paymentStatus: { old: from, new: to } });

/** The approver's step: keep the listed rows with their actions, round-tripped through JSON like the file. */
function approve(report: PaidRepairReport, decisions: Record<string, PaidRepairAction>) {
  const manifest = buildPaidRepairManifest(report);
  manifest.rows = manifest.rows.filter((row) => row.id in decisions).map((row) => ({ ...row, action: decisions[row.id]! }));
  return parsePaidRepairManifest(JSON.parse(JSON.stringify(manifest)));
}

async function readRegistration(id: string) {
  const [row] = await getDb().select().from(registrations).where(eq(registrations.id, id));
  return row!;
}

async function paidCounts(s: Scenario) {
  const rows = await getDb().select({ id: eventAccess.id, paid: eventAccess.paidCount }).from(eventAccess);
  const byId = new Map(rows.map((row) => [row.id, row.paid]));
  return { gala: byId.get(s.gala.id), dinner: byId.get(s.dinner.id) };
}

async function repairAudits(registrationId: string) {
  return getDb()
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityId, registrationId), eq(auditLogs.action, DATA_REPAIR_SETTLEMENT_AUDIT_ACTION)));
}

async function capacityDropsEnqueued() {
  return getDb().select().from(outboxEvents).where(eq(outboxEvents.type, ACCESS_CAPACITY_REACHED_OUTBOX_TYPE));
}

async function problemsOf(check: string, registrationId: string) {
  const report = await checkSettlementInvariants({ sampleLimit: 1000 });
  return report.checks
    .find((c) => c.name === check)!
    .samples.filter((row) => row.id === registrationId)
    .map((row) => row.problem);
}

describe.runIf(dbTestsEnabled())("db tier: PAID data repair (2.4)", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it("BACKFILL_PAID sets paid = net, moves no seats, audits, enqueues registration.updated, sends no email; once", async () => {
    const s = await scenario({ galaPaid: 1, dinnerPaid: 1 });
    const paidAt = daysAgo(10);
    const reg = await seedCandidate(s, { status: "PAID", paidAmount: 0, paidAt });
    await audit(reg.id, "CREATE", "admin-1", daysAgo(10), { totalAmount: { old: null, new: 400 } });

    const report = await planPaidSettlementRepair({ since: SINCE, eventId: s.event.id });
    expect(report.candidates).toEqual([
      expect.objectContaining({
        id: reg.id,
        section: "A",
        proposedAction: "BACKFILL_PAID",
        flags: [],
        net: 400,
        expected: { paymentStatus: "PAID", paidAmount: 0, updatedAt: reg.updatedAt.toISOString() },
        seatDelta: { BACKFILL_PAID: {}, CONVERT_PARTIAL: { [s.gala.id]: -1, [s.dinner.id]: -1 } },
      }),
    ]);
    expect(report.seatImpact).toEqual([]);
    expect(await problemsOf("status_vs_amounts", reg.id)).toEqual(["PAID_BELOW_NET"]);

    const manifest = approve(report, { [reg.id]: "BACKFILL_PAID" });
    const result = await applyPaidRepairRow(manifest.rows[0]!, { since: manifest.since });
    expect(result).toEqual({
      outcome: "applied",
      id: reg.id,
      action: "BACKFILL_PAID",
      before: { paymentStatus: "PAID", paidAmount: 0, paidAt: paidAt.toISOString() },
      after: { paymentStatus: "PAID", paidAmount: 400, paidAt: paidAt.toISOString() },
      seatsMoved: { incremented: [], decremented: [] },
    });
    const row = await readRegistration(reg.id);
    expect(row).toMatchObject({ paymentStatus: "PAID", paidAmount: 400, sponsorshipAmount: 0, totalAmount: 400 });
    expect(row.paidAt?.getTime()).toBe(paidAt.getTime());
    expect(await paidCounts(s)).toEqual({ gala: 1, dinner: 1 });

    const audits = await repairAudits(reg.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entityType: "Registration",
      performedBy: PAID_REPAIR_ACTOR,
      changes: {
        repairAction: { old: null, new: "BACKFILL_PAID" },
        repairSection: { old: null, new: "A" },
        paidAmount: { old: 0, new: 400 },
      },
    });
    expect(await realtimeRowsOf("registration.updated", reg.id)).toHaveLength(1);
    expect(await realtimeRowsOf("registration.paymentConfirmed", reg.id)).toHaveLength(0);
    expect(await getDb().select().from(emailLogs)).toEqual([]);
    expect(await problemsOf("status_vs_amounts", reg.id)).toEqual([]);

    // Running it again changes nothing.
    const again = await applyPaidRepairRow(manifest.rows[0]!, { since: manifest.since });
    expect(again).toMatchObject({ outcome: "skipped", reason: "ALREADY_APPLIED" });
    expect((await readRegistration(reg.id)).updatedAt.getTime()).toBe(row.updatedAt.getTime());
    expect(await repairAudits(reg.id)).toHaveLength(1);
    expect(await realtimeRowsOf("registration.updated", reg.id)).toHaveLength(1);
    expect((await planPaidSettlementRepair({ since: SINCE, eventId: s.event.id })).candidates).toEqual([]);
  });

  it("REPROMOTE_PAID of a partially sponsored PARTIAL row adds only the uncovered seats (B1)", async () => {
    const s = await scenario({ galaPaid: 1, dinnerPaid: 0 });
    const reg = await seedCandidate(s, { status: "PARTIAL", paidAmount: 0, sponsoredGala: true });
    const paidOn = daysAgo(20);
    await audit(reg.id, "CREATE", "PUBLIC", daysAgo(25));
    await audit(reg.id, "UPDATE", "admin-1", paidOn, status("PARTIAL", "PAID"));
    await audit(reg.id, "UPDATE", "admin-2", daysAgo(10), {
      ...status("PAID", "PARTIAL"),
      totalAmount: { old: 300, new: 400 },
    });

    const report = await planPaidSettlementRepair({ since: SINCE, eventId: s.event.id });
    expect(report.candidates).toEqual([
      expect.objectContaining({
        id: reg.id,
        section: "B1",
        proposedAction: "REPROMOTE_PAID",
        flags: [],
        net: 200,
        proposedPaidAt: paidOn.toISOString(),
        seatDelta: { REPROMOTE_PAID: { [s.dinner.id]: 1 } },
      }),
    ]);
    expect(report.seatImpact).toEqual([
      expect.objectContaining({ accessId: s.dinner.id, paidCount: 0, proposedDelta: 1, overCapacity: false }),
    ]);

    const manifest = approve(report, { [reg.id]: "REPROMOTE_PAID" });
    const result = await applyPaidRepairRow(manifest.rows[0]!, { since: manifest.since });
    expect(result).toMatchObject({
      outcome: "applied",
      after: { paymentStatus: "PAID", paidAmount: 200, paidAt: paidOn.toISOString() },
      seatsMoved: { incremented: [s.dinner.id], decremented: [] },
    });
    expect(await readRegistration(reg.id)).toMatchObject({ paymentStatus: "PAID", paidAmount: 200, sponsorshipAmount: 200 });
    expect(await paidCounts(s)).toEqual({ gala: 1, dinner: 1 });
    expect(await realtimeRowsOf("registration.updated", reg.id)).toHaveLength(1);
    expect(await realtimeRowsOf("registration.paymentConfirmed", reg.id)).toHaveLength(0);
    expect(await realtimeRowsOf("eventAccess.countsChanged", s.event.id)).toHaveLength(1);
    expect(await getDb().select().from(emailLogs)).toEqual([]);
  });

  it("REPROMOTE_PAID of a PENDING row adds every seat and enqueues the drop of an item it fills (B2)", async () => {
    const s = await scenario({ dinnerCapacity: 1 });
    const reg = await seedCandidate(s, { status: "PENDING", paidAmount: 0, lastEditedAt: daysAgo(5) });
    await audit(reg.id, "CREATE", "PUBLIC", daysAgo(25));
    await audit(reg.id, "UPDATE", "admin-1", daysAgo(20), status("PENDING", "PAID"));
    await audit(reg.id, "UPDATE", "PUBLIC", daysAgo(5), { formData: { old: {}, new: { phone: "1" } } });

    const report = await planPaidSettlementRepair({ since: SINCE, eventId: s.event.id });
    expect(report.candidates).toEqual([
      expect.objectContaining({
        id: reg.id,
        section: "B2",
        proposedAction: "REPROMOTE_PAID",
        seatDelta: { REPROMOTE_PAID: { [s.dinner.id]: 1, [s.gala.id]: 1 } },
      }),
    ]);

    const manifest = approve(report, { [reg.id]: "REPROMOTE_PAID" });
    expect(await applyPaidRepairRow(manifest.rows[0]!, { since: manifest.since })).toMatchObject({
      outcome: "applied",
      after: { paymentStatus: "PAID", paidAmount: 400 },
    });
    expect(await paidCounts(s)).toEqual({ gala: 1, dinner: 1 });
    expect(await capacityDropsEnqueued()).toHaveLength(1);
  });

  it("CONVERT_PARTIAL keeps the actual paid amount, clears paid_at and releases only the uncovered seats", async () => {
    const s = await scenario({ galaPaid: 1, dinnerPaid: 1 });
    const reg = await seedCandidate(s, { status: "PAID", paidAmount: 100, paidAt: daysAgo(15), sponsoredGala: true });
    await audit(reg.id, "PAYMENT_CONFIRMED", "admin-1", daysAgo(15), {
      ...status("PARTIAL", "PAID"),
      paidAmount: { old: 0, new: 100 },
    });

    const report = await planPaidSettlementRepair({ since: SINCE, eventId: s.event.id });
    expect(report.candidates).toEqual([
      expect.objectContaining({
        id: reg.id,
        section: "A",
        proposedAction: null,
        flags: ["RECORDED_AMOUNT"],
        net: 200,
        seatDelta: { BACKFILL_PAID: {}, CONVERT_PARTIAL: { [s.dinner.id]: -1 } },
      }),
    ]);

    const manifest = approve(report, { [reg.id]: "CONVERT_PARTIAL" });
    expect(await applyPaidRepairRow(manifest.rows[0]!, { since: manifest.since })).toMatchObject({
      outcome: "applied",
      after: { paymentStatus: "PARTIAL", paidAmount: 100, paidAt: null },
      seatsMoved: { incremented: [], decremented: [s.dinner.id] },
    });
    const row = await readRegistration(reg.id);
    expect(row).toMatchObject({ paymentStatus: "PARTIAL", paidAmount: 100, paidAt: null, sponsorshipAmount: 200 });
    expect(await paidCounts(s)).toEqual({ gala: 1, dinner: 0 });
    const [entry] = await repairAudits(reg.id);
    expect(entry!.changes).toEqual({
      repairAction: { old: null, new: "CONVERT_PARTIAL" },
      repairSection: { old: null, new: "A" },
      paymentStatus: { old: "PAID", new: "PARTIAL" },
      paidAt: { old: daysAgo(15).toISOString(), new: null },
    });
    // The converted row is not listed again.
    expect((await planPaidSettlementRepair({ since: SINCE, eventId: s.event.id })).candidates).toEqual([]);
  });

  it("skips a row whose approved snapshot is stale", async () => {
    const s = await scenario({ galaPaid: 1, dinnerPaid: 1 });
    const reg = await seedCandidate(s, { status: "PAID", paidAmount: 0, paidAt: daysAgo(10) });
    const manifest = approve(await planPaidSettlementRepair({ since: SINCE, eventId: s.event.id }), {
      [reg.id]: "BACKFILL_PAID",
    });
    // Someone edited the registration after the dry run.
    await getDb()
      .update(registrations)
      .set({ phone: "+216 00 000 000", updatedAt: new Date(reg.updatedAt.getTime() + 60_000) })
      .where(eq(registrations.id, reg.id));

    const result = await applyPaidRepairRow(manifest.rows[0]!, { since: manifest.since });
    expect(result).toMatchObject({ outcome: "skipped", id: reg.id, reason: "STALE" });
    expect(await readRegistration(reg.id)).toMatchObject({ paymentStatus: "PAID", paidAmount: 0 });
    expect(await repairAudits(reg.id)).toEqual([]);
    expect(await realtimeRowsOf("registration.updated", reg.id)).toEqual([]);
    expect(await paidCounts(s)).toEqual({ gala: 1, dinner: 1 });
  });

  it("leaves SKIP rows untouched", async () => {
    const s = await scenario({ galaPaid: 1, dinnerPaid: 1 });
    const reg = await seedCandidate(s, { status: "PAID", paidAmount: 0, paidAt: daysAgo(10) });
    const manifest = approve(await planPaidSettlementRepair({ since: SINCE, eventId: s.event.id }), { [reg.id]: "SKIP" });

    expect(await applyPaidRepairRow(manifest.rows[0]!, { since: manifest.since })).toEqual({
      outcome: "skipped",
      id: reg.id,
      action: "SKIP",
      reason: "SKIP",
      detail: "approved as SKIP",
    });
    const row = await readRegistration(reg.id);
    expect(row).toMatchObject({ paymentStatus: "PAID", paidAmount: 0 });
    expect(row.updatedAt.getTime()).toBe(reg.updatedAt.getTime());
    expect(await repairAudits(reg.id)).toEqual([]);
    expect(await realtimeRowsOf("registration.updated", reg.id)).toEqual([]);
  });

  it("skips a re-promotion that finds an access item full, changing nothing", async () => {
    // The only gala place is taken by someone else.
    const s = await scenario({ galaCapacity: 1, galaPaid: 1 });
    const reg = await seedCandidate(s, { status: "PENDING", paidAmount: 0 });
    await audit(reg.id, "CREATE", "PUBLIC", daysAgo(25));
    await audit(reg.id, "UPDATE", "admin-1", daysAgo(20), status("PENDING", "PAID"));
    await audit(reg.id, "UPDATE", "admin-2", daysAgo(10), { ...status("PAID", "PENDING"), totalAmount: { old: 300, new: 400 } });

    const report = await planPaidSettlementRepair({ since: SINCE, eventId: s.event.id });
    expect(report.candidates).toEqual([
      expect.objectContaining({ id: reg.id, section: "B1", proposedAction: "REPROMOTE_PAID", flags: ["CAPACITY_FULL"] }),
    ]);
    expect(report.seatImpact).toEqual(
      expect.arrayContaining([expect.objectContaining({ accessId: s.gala.id, proposedDelta: 1, overCapacity: true })]),
    );

    const manifest = approve(report, { [reg.id]: "REPROMOTE_PAID" });
    expect(await applyPaidRepairRow(manifest.rows[0]!, { since: manifest.since })).toMatchObject({
      outcome: "skipped",
      reason: "CAPACITY_FULL",
    });
    expect(await readRegistration(reg.id)).toMatchObject({ paymentStatus: "PENDING", paidAmount: 0, paidAt: null });
    expect(await paidCounts(s)).toEqual({ gala: 1, dinner: 0 });
    expect(await repairAudits(reg.id)).toEqual([]);
  });

  it("lists admin-created rows re-priced since --since for manual review and leaves other rows out", async () => {
    const s = await scenario();
    const adminCreated = await seedCandidate(s, { status: "PENDING", paidAmount: 0 });
    await audit(adminCreated.id, "CREATE", "admin-1", daysAgo(25));
    await audit(adminCreated.id, "UPDATE", "admin-1", daysAgo(10), { totalAmount: { old: 300, new: 400 } });
    const publicSignup = await seedCandidate(s, { status: "PENDING", paidAmount: 0, lastEditedAt: daysAgo(3) });
    await audit(publicSignup.id, "CREATE", "PUBLIC", daysAgo(25));
    await audit(publicSignup.id, "UPDATE", "PUBLIC", daysAgo(3), { formData: { old: {}, new: {} } });
    await seedCandidate(s, { status: "PAID", paidAmount: 400, paidAt: daysAgo(3) });
    const other = await scenario();
    await seedCandidate(other, { status: "PAID", paidAmount: 0, paidAt: daysAgo(3) });

    const report = await planPaidSettlementRepair({ since: SINCE, eventId: s.event.id });
    expect(report.candidates).toEqual([
      expect.objectContaining({
        id: adminCreated.id,
        section: "B3",
        proposedAction: null,
        flags: ["NO_STATUS_HISTORY"],
        seatDelta: { REPROMOTE_PAID: { [s.dinner.id]: 1, [s.gala.id]: 1 } },
      }),
    ]);
    // The dry-run manifest itself cannot be applied: nobody set the action.
    expect(() => parsePaidRepairManifest(JSON.parse(JSON.stringify(buildPaidRepairManifest(report))))).toThrow(
      PaidRepairManifestError,
    );
    // Without the event filter the other event's A row shows up too.
    const all = await planPaidSettlementRepair({ since: SINCE });
    expect(all.candidates.map((c) => c.section).sort()).toEqual(["A", "B3"]);
  });
});
