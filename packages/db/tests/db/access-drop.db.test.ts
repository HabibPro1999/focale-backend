import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  ACCESS_CAPACITY_REACHED_OUTBOX_TYPE,
  auditLogs,
  dropAccessFromUnsettledRegistrations,
  enqueueAccessDrops,
  eventAccess,
  getDb,
  handleAccessCapacityReachedOutbox,
  outboxEvents,
  processOutboxEvents,
  registrations,
  withTxn,
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

// Plan 2.8: when an access item fills up or is deactivated, the transaction
// that did it only enqueues `access.capacityReached`. The worker's outbox
// handler then drops the item from each unsettled registration holding it
// (not covered by a sponsorship), one locking transaction per registration,
// through settleRegistrationTxn.

type Item = { id: string; price: number };

function breakdown(base: number, items: Item[], sponsorship = 0) {
  const accessItems = items.map((item) => ({
    accessId: item.id,
    name: item.id,
    unitPrice: item.price,
    quantity: 1,
    subtotal: item.price,
  }));
  const accessTotal = accessItems.reduce((sum, item) => sum + item.subtotal, 0);
  const subtotal = base + accessTotal;
  const sponsorshipTotal = Math.min(sponsorship, subtotal);
  return {
    basePrice: base,
    appliedRules: [],
    calculatedBasePrice: base,
    accessItems,
    accessTotal,
    subtotal,
    sponsorships: [],
    sponsorshipTotal,
    total: subtotal - sponsorshipTotal,
    currency: "TND",
    droppedAccessItems: [],
  };
}

async function scenario() {
  const event = await seedEvent({ status: "OPEN" });
  const form = await seedForm({ eventId: event.id });
  // The gala is full (1 of 1 paid place taken).
  const gala = await seedEventAccess({
    eventId: event.id,
    name: "Gala",
    price: 200,
    maxCapacity: 1,
    paidCount: 1,
    registeredCount: 4,
  });
  const dinner = await seedEventAccess({ eventId: event.id, name: "Dinner", price: 100, registeredCount: 1 });
  return { event, form, gala, dinner };
}

type Scenario = Awaited<ReturnType<typeof scenario>>;

function registrationHolding(
  s: Scenario,
  items: Item[],
  options: { status?: "PENDING" | "PARTIAL" | "PAID" | "VERIFYING"; paidAmount?: number; sponsorship?: number; base?: number } = {},
) {
  const pb = breakdown(options.base ?? 300, items, options.sponsorship ?? 0);
  return seedRegistration({
    eventId: s.event.id,
    formId: s.form.id,
    paymentStatus: options.status ?? "PENDING",
    paidAmount: options.paidAmount ?? 0,
    paidAt: options.status === "PAID" ? new Date() : null,
    totalAmount: pb.subtotal,
    baseAmount: pb.calculatedBasePrice,
    accessAmount: pb.accessTotal,
    sponsorshipAmount: pb.sponsorshipTotal,
    priceBreakdown: pb,
    accessTypeIds: items.map((item) => item.id),
  });
}

async function readRegistration(id: string) {
  const [row] = await getDb().select().from(registrations).where(eq(registrations.id, id));
  return row!;
}

async function counts(accessId: string) {
  const [row] = await getDb()
    .select({ paid: eventAccess.paidCount, registered: eventAccess.registeredCount })
    .from(eventAccess)
    .where(eq(eventAccess.id, accessId));
  return row!;
}

async function outboxOfType(type: string) {
  return getDb().select().from(outboxEvents).where(eq(outboxEvents.type, type));
}

async function auditActions(registrationId: string) {
  const rows = await getDb()
    .select({ action: auditLogs.action, changes: auditLogs.changes, performedBy: auditLogs.performedBy })
    .from(auditLogs)
    .where(and(eq(auditLogs.entityType, "Registration"), eq(auditLogs.entityId, registrationId)));
  return rows;
}

/**
 * Run the worker's outbox passes for the drop events until none is pending.
 * On CockroachDB, the claim's SKIP LOCKED can transiently miss rows just
 * written by a committed transaction (cockroachdb/cockroach#167582); a later
 * pass gets them, as the next worker tick would in production.
 */
async function runWorkerDrops() {
  const totals = { processed: 0, failed: 0 };
  await vi.waitFor(
    async () => {
      const result = await processOutboxEvents(20, {
        workerId: "access-drop-test",
        scope: "background",
        handlers: { [ACCESS_CAPACITY_REACHED_OUTBOX_TYPE]: handleAccessCapacityReachedOutbox },
      });
      totals.processed += result.processed;
      totals.failed += result.failed;
      if (totals.failed > 0) return;
      const pending = (await outboxOfType(ACCESS_CAPACITY_REACHED_OUTBOX_TYPE)).filter((row) => row.status === "PENDING");
      expect(pending).toEqual([]);
    },
    { timeout: 10_000, interval: 50 },
  );
  return totals;
}

describe.runIf(dbTestsEnabled())("db tier: access capacity drop (worker outbox job)", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it("enqueues a capacity drop only for items at capacity; a deactivation always", async () => {
    const s = await scenario();

    const enqueued = await withTxn(async (tx) => ({
      capacity: await enqueueAccessDrops(tx, s.event.id, [s.dinner.id, s.gala.id, s.gala.id], "capacity_reached"),
      deactivated: await enqueueAccessDrops(tx, s.event.id, [s.dinner.id], "deactivated"),
    }));

    expect(enqueued).toEqual({ capacity: [s.gala.id], deactivated: [s.dinner.id] });
    const rows = await outboxOfType(ACCESS_CAPACITY_REACHED_OUTBOX_TYPE);
    expect(rows.map((row) => row.payload).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual(
      [
        { eventId: s.event.id, accessId: s.dinner.id, reason: "deactivated" },
        { eventId: s.event.id, accessId: s.gala.id, reason: "capacity_reached" },
      ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
  });

  it("the worker drops the full item from unsettled registrations and settles each", async () => {
    const s = await scenario();
    const gala = { id: s.gala.id, price: 200 };
    const dinner = { id: s.dinner.id, price: 100 };
    const pending = await registrationHolding(s, [gala, dinner]);
    const paid = await registrationHolding(s, [gala], { status: "PAID", paidAmount: 500 });
    const partial = await registrationHolding(s, [gala], { status: "PARTIAL", paidAmount: 100 });
    await withTxn((tx) => enqueueAccessDrops(tx, s.event.id, [s.gala.id], "capacity_reached"));

    const result = await runWorkerDrops();

    expect(result).toMatchObject({ processed: 1, failed: 0 });
    expect(await readRegistration(pending.id)).toMatchObject({
      paymentStatus: "PENDING",
      totalAmount: 400,
      accessAmount: 100,
      accessTypeIds: [s.dinner.id],
      droppedAccessIds: [s.gala.id],
    });
    const pendingBreakdown = (await readRegistration(pending.id)).priceBreakdown as ReturnType<typeof breakdown> & {
      droppedAccessItems: Array<{ accessId: string; reason: string }>;
    };
    expect(pendingBreakdown).toMatchObject({ subtotal: 400, accessTotal: 100, total: 400 });
    expect(pendingBreakdown.droppedAccessItems).toEqual([expect.objectContaining({ accessId: s.gala.id, reason: "capacity_reached" })]);
    expect(await readRegistration(partial.id)).toMatchObject({ paymentStatus: "PARTIAL", totalAmount: 300, paidAmount: 100 });
    // Settled registrations keep the item.
    expect(await readRegistration(paid.id)).toMatchObject({ paymentStatus: "PAID", accessTypeIds: [s.gala.id], totalAmount: 500 });
    // Two registered places released; the paid count is unchanged (neither held a paid gala place).
    expect(await counts(s.gala.id)).toEqual({ paid: 1, registered: 2 });
    expect(await auditActions(pending.id)).toEqual([
      expect.objectContaining({
        action: "ACCESS_CAPACITY_REACHED",
        performedBy: "SYSTEM",
        changes: {
          accessDropped: { old: "Gala", new: "capacity_reached" },
          totalAmount: { old: 600, new: 400 },
          priceDeducted: { old: 0, new: 200 },
        },
      }),
    ]);

    // A second pass (a redelivered event) finds nothing left to drop.
    await withTxn((tx) => enqueueAccessDrops(tx, s.event.id, [s.gala.id], "capacity_reached"));
    await runWorkerDrops();
    expect(await counts(s.gala.id)).toEqual({ paid: 1, registered: 2 });
    expect(await auditActions(pending.id)).toHaveLength(1);
  });

  it("a registration the drop leaves fully sponsored becomes SPONSORED, takes its paid places and is confirmed", async () => {
    const s = await scenario();
    const gala = { id: s.gala.id, price: 200 };
    const dinner = { id: s.dinner.id, price: 100 };
    // A lab covers the base and the dinner (400); the gala keeps it PARTIAL.
    const reg = await registrationHolding(s, [gala, dinner], { status: "PARTIAL", sponsorship: 400 });
    const batch = await seedSponsorshipBatch({ eventId: s.event.id, formId: s.form.id });
    const sponsorship = await seedSponsorship({
      batchId: batch.id,
      eventId: s.event.id,
      status: "USED",
      coversBasePrice: true,
      coveredAccessIds: [s.dinner.id],
      totalAmount: 400,
    });
    await seedSponsorshipUsage({ sponsorshipId: sponsorship.id, registrationId: reg.id, amountApplied: 400, appliedBy: "admin" });
    await getDb().update(eventAccess).set({ paidCount: 1 }).where(eq(eventAccess.id, s.dinner.id));
    await withTxn((tx) => enqueueAccessDrops(tx, s.event.id, [s.gala.id], "capacity_reached"));

    await runWorkerDrops();

    const row = await readRegistration(reg.id);
    expect(row).toMatchObject({ paymentStatus: "SPONSORED", totalAmount: 400, sponsorshipAmount: 400 });
    expect(row.paidAt).not.toBeNull();
    // The covered dinner already held its paid place; SPONSORED holds it too (no double count).
    expect(await counts(s.dinner.id)).toMatchObject({ paid: 1 });
    const emails = await outboxOfType("email.triggered");
    expect(emails.map((email) => email.dedupeKey)).toContain(`email:triggered:PAYMENT_CONFIRMED:${reg.id}`);
    expect(await auditActions(reg.id)).toEqual([
      expect.objectContaining({
        changes: expect.objectContaining({ paymentStatus: { old: "PARTIAL", new: "SPONSORED" } }),
      }),
    ]);
  });

  it("keeps the item for a covered item, an overpaid registration (recorded once), or an item no longer full", async () => {
    const s = await scenario();
    const gala = { id: s.gala.id, price: 200 };
    const covered = await registrationHolding(s, [gala], { status: "PARTIAL", sponsorship: 200 });
    const batch = await seedSponsorshipBatch({ eventId: s.event.id, formId: s.form.id });
    const sponsorship = await seedSponsorship({
      batchId: batch.id,
      eventId: s.event.id,
      status: "USED",
      coversBasePrice: false,
      coveredAccessIds: [s.gala.id],
      totalAmount: 200,
    });
    await seedSponsorshipUsage({ sponsorshipId: sponsorship.id, registrationId: covered.id, amountApplied: 200, appliedBy: "admin" });
    // Paid 450 of 500: without the gala it would owe 300.
    const overpaid = await registrationHolding(s, [gala], { status: "PARTIAL", paidAmount: 450 });

    await handleAccessCapacityReachedOutbox({ eventId: s.event.id, accessId: s.gala.id, reason: "capacity_reached" });

    expect(await readRegistration(covered.id)).toMatchObject({ accessTypeIds: [s.gala.id], totalAmount: 500 });
    expect(await readRegistration(overpaid.id)).toMatchObject({
      paymentStatus: "PARTIAL",
      accessTypeIds: [s.gala.id],
      totalAmount: 500,
      paidAmount: 450,
    });
    expect(await auditActions(covered.id)).toEqual([]);
    // The overpaid skip is recorded on the registration for an admin to handle.
    const overpaidSkip = {
      action: "ACCESS_DROP_SKIPPED_OVERPAID",
      performedBy: "SYSTEM",
      changes: {
        accessKept: { old: "Gala", new: "capacity_reached" },
        accessId: { old: null, new: s.gala.id },
        paidAmount: { old: null, new: 450 },
        amountDue: { old: null, new: 500 },
        amountDueWithoutAccess: { old: null, new: 300 },
      },
    };
    expect(await auditActions(overpaid.id)).toEqual([overpaidSkip]);
    // A redelivered event skips it again without repeating the entry.
    const again = await dropAccessFromUnsettledRegistrations({
      eventId: s.event.id,
      accessId: s.gala.id,
      reason: "capacity_reached",
    });
    expect(again.skipped).toEqual(
      expect.arrayContaining([
        { registrationId: covered.id, reason: "COVERED" },
        { registrationId: overpaid.id, reason: "OVERPAID" },
      ]),
    );
    expect(await auditActions(overpaid.id)).toEqual([overpaidSkip]);

    // A place freed since: nothing is dropped.
    const later = await registrationHolding(s, [gala]);
    await getDb().update(eventAccess).set({ paidCount: 0 }).where(eq(eventAccess.id, s.gala.id));
    await handleAccessCapacityReachedOutbox({ eventId: s.event.id, accessId: s.gala.id, reason: "capacity_reached" });
    expect(await readRegistration(later.id)).toMatchObject({ accessTypeIds: [s.gala.id] });
  });

  it("a deactivated item is dropped with the deactivation audit; a malformed payload is skipped", async () => {
    const s = await scenario();
    const dinner = { id: s.dinner.id, price: 100 };
    const reg = await registrationHolding(s, [dinner]);
    await getDb().update(eventAccess).set({ active: false }).where(eq(eventAccess.id, s.dinner.id));

    expect(
      await handleAccessCapacityReachedOutbox({ eventId: s.event.id, accessId: s.dinner.id, reason: "deactivated" }),
    ).toBe("processed");

    expect(await readRegistration(reg.id)).toMatchObject({ totalAmount: 300, accessTypeIds: [] });
    expect((await auditActions(reg.id)).map((row) => row.action)).toEqual(["ACCESS_DEACTIVATED"]);
    expect(await handleAccessCapacityReachedOutbox({ accessId: s.dinner.id })).toBe("skipped");
  });
});
