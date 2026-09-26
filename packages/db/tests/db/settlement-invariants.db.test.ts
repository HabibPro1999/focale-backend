import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSettlementInvariants, type SettlementInvariantReport } from "@app/db";
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

// Plan 2.4: the settlement invariant checks (reusable module, also meant for
// a staging job). Read-only SQL; both engines.

type Item = { id: string; price: number };

function breakdown(base: number, items: Item[], sponsorship: number) {
  const accessItems = items.map((item) => ({
    accessId: item.id,
    name: item.id,
    unitPrice: item.price,
    quantity: 1,
    subtotal: item.price,
  }));
  const accessTotal = accessItems.reduce((sum, item) => sum + item.subtotal, 0);
  const subtotal = base + accessTotal;
  return {
    basePrice: base,
    appliedRules: [],
    calculatedBasePrice: base,
    accessItems,
    accessTotal,
    subtotal,
    sponsorships: [],
    sponsorshipTotal: sponsorship,
    total: subtotal - sponsorship,
    currency: "TND",
    droppedAccessItems: [],
  };
}

async function eventWithAccess(counts: { registered: number; gala: [number, number]; dinner: [number, number] }) {
  const event = await seedEvent({ status: "OPEN", registeredCount: counts.registered });
  const form = await seedForm({ eventId: event.id });
  const gala = await seedEventAccess({
    eventId: event.id,
    name: "Gala",
    price: 200,
    registeredCount: counts.gala[0],
    paidCount: counts.gala[1],
  });
  const dinner = await seedEventAccess({
    eventId: event.id,
    name: "Dinner",
    price: 100,
    registeredCount: counts.dinner[0],
    paidCount: counts.dinner[1],
  });
  return { event, form, gala: { id: gala.id, price: 200 }, dinner: { id: dinner.id, price: 100 } };
}

type Fixture = Awaited<ReturnType<typeof eventWithAccess>>;

/** A consistent registration (base 100), then `overrides` break one thing. */
function registration(
  f: Fixture,
  values: { items: Item[]; status: "PENDING" | "PARTIAL" | "PAID"; paid: number; sponsorship?: number },
  overrides: Parameters<typeof seedRegistration>[0] = {},
) {
  const pb = breakdown(100, values.items, values.sponsorship ?? 0);
  return seedRegistration({
    eventId: f.event.id,
    formId: f.form.id,
    paymentStatus: values.status,
    paidAmount: values.paid,
    paidAt: values.status === "PAID" ? new Date() : null,
    totalAmount: pb.subtotal,
    baseAmount: pb.calculatedBasePrice,
    accessAmount: pb.accessTotal,
    sponsorshipAmount: pb.sponsorshipTotal,
    priceBreakdown: pb,
    accessTypeIds: values.items.map((item) => item.id),
    ...overrides,
  });
}

async function sponsorGala(f: Fixture, registrationIds: string[], options: { status?: "PENDING" | "USED" } = {}) {
  const batch = await seedSponsorshipBatch({ eventId: f.event.id, formId: f.form.id });
  const sponsorship = await seedSponsorship({
    batchId: batch.id,
    eventId: f.event.id,
    status: options.status ?? "USED",
    totalAmount: 200,
    coversBasePrice: false,
    coveredAccessIds: [f.gala.id],
  });
  for (const registrationId of registrationIds) {
    await seedSponsorshipUsage({ sponsorshipId: sponsorship.id, registrationId, amountApplied: 200, appliedBy: "admin-1" });
  }
  return sponsorship;
}

function problems(report: SettlementInvariantReport, check: string) {
  return report.checks.find((c) => c.name === check)!.samples.map((row) => ({ id: row.id, problem: row.problem }));
}

describe.runIf(dbTestsEnabled())("db tier: settlement invariants (2.4)", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it("a consistent event passes every check", async () => {
    // Gala: 3 registered, 2 paid (the PAID row and the PARTIAL row's covered gala).
    const f = await eventWithAccess({ registered: 3, gala: [3, 2], dinner: [1, 0] });
    await registration(f, { items: [f.gala], status: "PAID", paid: 300 });
    const partial = await registration(f, { items: [f.gala, f.dinner], status: "PARTIAL", paid: 0, sponsorship: 200 });
    await sponsorGala(f, [partial.id]);
    await registration(f, { items: [f.gala], status: "PENDING", paid: 0 });

    const report = await checkSettlementInvariants({ eventId: f.event.id });
    expect(report.checks.map((check) => [check.name, check.violations])).toEqual([
      ["breakdown_vs_columns", 0],
      ["status_vs_amounts", 0],
      ["sponsorship_vs_usages", 0],
      ["duplicate_codes", 0],
      ["count_drift", 0],
    ]);
    expect(report.ok).toBe(true);
    expect(report.eventId).toBe(f.event.id);
  });

  it("reports the offending rows of each check", async () => {
    const f = await eventWithAccess({ registered: 0, gala: [0, 5], dinner: [0, 0] });
    const noBreakdown = await registration(f, { items: [f.gala], status: "PENDING", paid: 0 }, { priceBreakdown: {} });
    const mismatch = await registration(f, { items: [f.gala], status: "PENDING", paid: 0 }, { sponsorshipAmount: 0, priceBreakdown: breakdown(100, [f.gala], 50) });
    const paidBelow = await registration(f, { items: [f.gala], status: "PAID", paid: 0 });
    const pendingPaid = await registration(f, { items: [f.gala], status: "PENDING", paid: 100 });
    const partialPaidAt = await registration(f, { items: [f.gala], status: "PARTIAL", paid: 50 }, { paidAt: new Date() });
    const overpaid = await registration(f, { items: [f.gala], status: "PARTIAL", paid: 500 });
    const unlinked = await registration(f, { items: [f.gala], status: "PARTIAL", paid: 0, sponsorship: 100 });
    const wrongSum = await registration(f, { items: [f.gala, f.dinner], status: "PARTIAL", paid: 0, sponsorship: 150 });
    await sponsorGala(f, [wrongSum.id]);
    const unusedButUsed = await seedSponsorship({
      batchId: (await seedSponsorshipBatch({ eventId: f.event.id, formId: f.form.id })).id,
      eventId: f.event.id,
      status: "USED",
    });
    const shared1 = await registration(f, { items: [f.gala], status: "PENDING", paid: 0 }, { sponsorshipCode: " sp-dup " });
    const shared2 = await registration(f, { items: [f.gala], status: "PENDING", paid: 0 }, { sponsorshipCode: "SP-DUP" });
    const linkedTwice = await sponsorGala(f, [shared1.id, shared2.id], { status: "PENDING" });

    const report = await checkSettlementInvariants({ eventId: f.event.id, sampleLimit: 1000 });
    expect(report.ok).toBe(false);
    expect(problems(report, "breakdown_vs_columns")).toEqual(
      expect.arrayContaining([
        { id: noBreakdown.id, problem: "BREAKDOWN_INCOMPLETE" },
        { id: mismatch.id, problem: "SPONSORSHIP_TOTAL_MISMATCH" },
      ]),
    );
    expect(problems(report, "status_vs_amounts")).toEqual(
      expect.arrayContaining([
        { id: paidBelow.id, problem: "PAID_BELOW_NET" },
        { id: pendingPaid.id, problem: "PENDING_WITH_PAYMENT" },
        { id: partialPaidAt.id, problem: "UNSETTLED_WITH_PAID_AT" },
        { id: overpaid.id, problem: "OVERPAID" },
      ]),
    );
    expect(problems(report, "sponsorship_vs_usages")).toEqual(
      expect.arrayContaining([
        { id: unlinked.id, problem: "AMOUNT_WITHOUT_USAGE" },
        { id: wrongSum.id, problem: "AMOUNT_NOT_USAGE_SUM" },
        { id: unusedButUsed.id, problem: "USED_WITHOUT_USAGE" },
        { id: linkedTwice.id, problem: "PENDING_WITH_USAGE" },
      ]),
    );
    const duplicates = report.checks.find((c) => c.name === "duplicate_codes")!.samples;
    expect(duplicates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          problem: "CODE_STORED_BY_SEVERAL",
          code: "SP-DUP",
          count: 2,
          registrationIds: [shared1.id, shared2.id].sort(),
        }),
        expect.objectContaining({
          id: linkedTwice.id,
          problem: "LINKED_TO_SEVERAL",
          count: 2,
          registrationIds: [shared1.id, shared2.id].sort(),
        }),
      ]),
    );
    const drift = report.checks.find((c) => c.name === "count_drift")!.samples;
    expect(drift).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: f.event.id, problem: "EVENT_REGISTERED_COUNT_DRIFT", storedRegistered: 0, actualRegistered: 10 }),
        // Gala: 9 registered (the empty breakdown holds nothing); paid = the PAID row + the sponsored
        // gala of the one PARTIAL row linked to a sponsorship (the shared-code rows are PENDING).
        expect.objectContaining({
          id: f.gala.id,
          problem: "ACCESS_REGISTERED_AND_PAID_COUNT_DRIFT",
          storedRegistered: 0,
          actualRegistered: 9,
          storedPaid: 5,
          actualPaid: 2,
        }),
        expect.objectContaining({ id: f.dinner.id, problem: "ACCESS_REGISTERED_COUNT_DRIFT", actualRegistered: 1 }),
      ]),
    );
  });

  it("limits every check to one event and caps the samples", async () => {
    const clean = await eventWithAccess({ registered: 1, gala: [1, 1], dinner: [0, 0] });
    await registration(clean, { items: [clean.gala], status: "PAID", paid: 300 });
    const dirty = await eventWithAccess({ registered: 2, gala: [2, 2], dinner: [0, 0] });
    await registration(dirty, { items: [dirty.gala], status: "PAID", paid: 0 });
    await registration(dirty, { items: [dirty.gala], status: "PAID", paid: 10 });

    expect((await checkSettlementInvariants({ eventId: clean.event.id })).ok).toBe(true);
    const all = await checkSettlementInvariants({ sampleLimit: 1 });
    const status = all.checks.find((c) => c.name === "status_vs_amounts")!;
    expect(status.violations).toBe(2);
    expect(status.samples).toHaveLength(1);
    expect(all.ok).toBe(false);
  });
});
