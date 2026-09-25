import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  AccessCapacityExceededError,
  SettlementInvariantError,
  applyRegistrationSettlement,
  eventAccess,
  getDb,
  registrations,
  settleRegistrationTxn,
  sponsorshipUsages,
  withLockingTxn,
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

// Plan 2.6a: applyRegistrationSettlement is the only writer of a
// registration's money columns; settleRegistrationTxn locks, recomputes
// sponsorship usages, derives the status, moves paid counts and writes.

const NOW = new Date("2027-05-01T10:00:00.000Z");

function breakdown(options: { base: number; items?: Array<{ accessId: string; subtotal: number }>; sponsorship?: number }) {
  const items = (options.items ?? []).map((item) => ({
    accessId: item.accessId,
    name: item.accessId,
    unitPrice: item.subtotal,
    quantity: 1,
    subtotal: item.subtotal,
  }));
  const accessTotal = items.reduce((sum, item) => sum + item.subtotal, 0);
  const subtotal = options.base + accessTotal;
  const sponsorshipTotal = Math.min(options.sponsorship ?? 0, subtotal);
  return {
    basePrice: options.base,
    appliedRules: [{ ruleId: "r1", ruleName: "Early", effect: -50 }],
    calculatedBasePrice: options.base,
    accessItems: items,
    accessTotal,
    subtotal,
    sponsorships: [],
    sponsorshipTotal,
    total: subtotal - sponsorshipTotal,
    currency: "TND",
    droppedAccessItems: [],
  };
}

async function readRegistration(id: string) {
  const [row] = await getDb().select().from(registrations).where(eq(registrations.id, id));
  return row!;
}

async function paidCount(accessId: string): Promise<number> {
  const [row] = await getDb().select({ paidCount: eventAccess.paidCount }).from(eventAccess).where(eq(eventAccess.id, accessId));
  return row!.paidCount;
}

async function seedRegistrationWith(values: Parameters<typeof seedRegistration>[0] = {}) {
  const event = await seedEvent({ status: "OPEN" });
  const form = await seedForm({ eventId: event.id });
  const registration = await seedRegistration({ eventId: event.id, formId: form.id, ...values });
  return { event, form, registration };
}

describe.runIf(dbTestsEnabled())("db tier: settlement writer", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  describe("applyRegistrationSettlement", () => {
    it("writes the settlement and other fields in one update, deriving the amounts from the breakdown", async () => {
      const { registration } = await seedRegistrationWith({ totalAmount: 0, priceBreakdown: breakdown({ base: 0 }) });
      const pb = breakdown({ base: 300, items: [{ accessId: "gala", subtotal: 200 }], sponsorship: 100 });
      const written = await withTxn((tx) =>
        applyRegistrationSettlement(tx, {
          registrationId: registration.id,
          settlement: { totalAmount: 500, sponsorshipAmount: 100, priceBreakdown: pb, paymentStatus: "PARTIAL", paidAmount: 150 },
          fields: { note: "adjusted" },
        }),
      );
      expect(written).toBe(true);
      const row = await readRegistration(registration.id);
      expect(row).toMatchObject({
        totalAmount: 500,
        sponsorshipAmount: 100,
        paidAmount: 150,
        paymentStatus: "PARTIAL",
        baseAmount: 300,
        accessAmount: 200,
        discountAmount: 50,
        note: "adjusted",
      });
      expect(row.priceBreakdown).toEqual(pb);
      expect(row.updatedAt.getTime()).toBeGreaterThan(registration.updatedAt.getTime());
    });

    it("writes nothing when updatedAt no longer matches", async () => {
      const { registration } = await seedRegistrationWith({ totalAmount: 100, priceBreakdown: breakdown({ base: 100 }) });
      const stale = new Date(registration.updatedAt.getTime() - 1000);
      expect(
        await withTxn((tx) =>
          applyRegistrationSettlement(tx, {
            registrationId: registration.id,
            settlement: { paymentStatus: "VERIFYING" },
            expectedUpdatedAt: stale,
          }),
        ),
      ).toBe(false);
      expect((await readRegistration(registration.id)).paymentStatus).toBe("PENDING");
      expect(
        await withTxn((tx) =>
          applyRegistrationSettlement(tx, {
            registrationId: registration.id,
            settlement: { paymentStatus: "VERIFYING" },
            expectedUpdatedAt: registration.updatedAt,
          }),
        ),
      ).toBe(true);
      expect((await readRegistration(registration.id)).paymentStatus).toBe("VERIFYING");
    });

    it("rolls the transaction back when the written state breaks an invariant", async () => {
      const { registration } = await seedRegistrationWith({
        totalAmount: 500,
        sponsorshipAmount: 100,
        priceBreakdown: breakdown({ base: 500, sponsorship: 100 }),
      });
      // paid > net (500 − 100), judged with the stored total and sponsorship.
      const error = await withTxn(async (tx) => {
        await applyRegistrationSettlement(tx, {
          registrationId: registration.id,
          settlement: { paymentStatus: "PAID", paidAmount: 450 },
          fields: { note: "must not stick" },
        });
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SettlementInvariantError);
      expect((error as SettlementInvariantError).violations).toEqual(["paid_amount 450 exceeds the net 400"]);
      const row = await readRegistration(registration.id);
      expect(row).toMatchObject({ paymentStatus: "PENDING", paidAmount: 0, note: null });
    });

    it("rejects a breakdown that does not match the columns", async () => {
      const { registration } = await seedRegistrationWith({ totalAmount: 500, priceBreakdown: breakdown({ base: 500 }) });
      await expect(
        withTxn((tx) =>
          applyRegistrationSettlement(tx, {
            registrationId: registration.id,
            settlement: { sponsorshipAmount: 200, priceBreakdown: breakdown({ base: 500, sponsorship: 100 }) },
          }),
        ),
      ).rejects.toThrow(/sponsorshipTotal 100 differs from sponsorship_amount 200/);
      expect((await readRegistration(registration.id)).sponsorshipAmount).toBe(0);
    });

    it("tolerates inconsistent stored values the write does not touch", async () => {
      // Written before the writer existed: sponsorship above the total.
      const { registration } = await seedRegistrationWith({ totalAmount: 100, sponsorshipAmount: 150 });
      await withTxn((tx) =>
        applyRegistrationSettlement(tx, { registrationId: registration.id, settlement: { paymentStatus: "VERIFYING" } }),
      );
      expect((await readRegistration(registration.id)).paymentStatus).toBe("VERIFYING");
    });

    it("leaves the money columns it is not given unchanged", async () => {
      const paidAt = new Date("2027-04-01T00:00:00.000Z");
      const pb = breakdown({ base: 500, sponsorship: 100 });
      const { registration } = await seedRegistrationWith({
        totalAmount: 500,
        sponsorshipAmount: 100,
        paidAmount: 400,
        paymentStatus: "PAID",
        paidAt,
        priceBreakdown: pb,
      });
      await withTxn((tx) =>
        applyRegistrationSettlement(tx, {
          registrationId: registration.id,
          settlement: { paymentStatus: "REFUNDED" },
          fields: { paymentReference: "RF-1" },
        }),
      );
      const row = await readRegistration(registration.id);
      expect(row).toMatchObject({
        paymentStatus: "REFUNDED",
        paymentReference: "RF-1",
        totalAmount: 500,
        sponsorshipAmount: 100,
        paidAmount: 400,
        paidAt,
      });
      expect(row.priceBreakdown).toEqual(pb);
    });

    it("refuses to write outside a transaction", async () => {
      const { registration } = await seedRegistrationWith();
      await expect(
        applyRegistrationSettlement(getDb(), { registrationId: registration.id, settlement: { paymentStatus: "PAID" } }),
      ).rejects.toThrow(/inside a transaction/);
    });
  });

  describe("settleRegistrationTxn", () => {
    async function sponsoredFixture(options: { galaCapacity?: number | null; status?: "PENDING" | "PAID" } = {}) {
      const event = await seedEvent({ status: "OPEN" });
      const form = await seedForm({ eventId: event.id });
      const gala = await seedEventAccess({ eventId: event.id, name: "Gala", price: 200, maxCapacity: options.galaCapacity ?? null });
      const pb = breakdown({ base: 300, items: [{ accessId: gala.id, subtotal: 200 }] });
      const registration = await seedRegistration({
        eventId: event.id,
        formId: form.id,
        totalAmount: 500,
        priceBreakdown: pb,
        accessTypeIds: [gala.id],
        paymentStatus: options.status ?? "PENDING",
        ...(options.status === "PAID" ? { paidAmount: 500, paidAt: new Date("2027-04-01T00:00:00.000Z") } : {}),
      });
      const batch = await seedSponsorshipBatch({ eventId: event.id, formId: form.id });
      const sponsorship = await seedSponsorship({
        batchId: batch.id,
        eventId: event.id,
        coversBasePrice: true,
        coveredAccessIds: [gala.id],
        totalAmount: 500,
        status: "USED",
      });
      // Stored before the breakdown was final: the recompute corrects it.
      const usage = await seedSponsorshipUsage({
        sponsorshipId: sponsorship.id,
        registrationId: registration.id,
        amountApplied: 100,
        appliedBy: "test",
      });
      return { event, gala, registration, usage };
    }

    it("recomputes the usage, derives SPONSORED, takes the paid place and writes the net breakdown", async () => {
      const { gala, registration, usage } = await sponsoredFixture();
      const result = await withLockingTxn((tx) => settleRegistrationTxn(tx, registration.id, { now: NOW }));
      expect(result).toMatchObject({
        written: true,
        before: { paymentStatus: "PENDING", sponsorshipAmount: 0 },
        after: { paymentStatus: "SPONSORED", paidAt: NOW, sponsorshipAmount: 500, totalAmount: 500 },
        coveredAccessIds: [gala.id],
        paidAccess: { incremented: [gala.id], decremented: [] },
      });
      const row = await readRegistration(registration.id);
      expect(row).toMatchObject({ paymentStatus: "SPONSORED", sponsorshipAmount: 500, paidAt: NOW });
      expect(row.priceBreakdown).toMatchObject({ sponsorshipTotal: 500, total: 0, subtotal: 500 });
      const [storedUsage] = await getDb().select().from(sponsorshipUsages).where(eq(sponsorshipUsages.id, usage.id));
      expect(storedUsage!.amountApplied).toBe(500);
      expect(await paidCount(gala.id)).toBe(1);
    });

    it("keeps a sticky status and only corrects the amounts", async () => {
      const { gala, registration } = await sponsoredFixture({ status: "PAID" });
      const result = await withLockingTxn((tx) => settleRegistrationTxn(tx, registration.id, { now: NOW }));
      expect(result?.after).toMatchObject({ paymentStatus: "PAID", paidAt: new Date("2027-04-01T00:00:00.000Z") });
      expect(result?.paidAccess).toEqual({ incremented: [], decremented: [] });
      expect(await readRegistration(registration.id)).toMatchObject({ paymentStatus: "PAID", sponsorshipAmount: 500 });
      expect(await paidCount(gala.id)).toBe(0);
    });

    it("changes nothing when updatedAt no longer matches", async () => {
      const { gala, registration, usage } = await sponsoredFixture();
      const result = await withLockingTxn((tx) =>
        settleRegistrationTxn(tx, registration.id, { expectedUpdatedAt: new Date(0), now: NOW }),
      );
      expect(result?.written).toBe(false);
      expect((await readRegistration(registration.id)).paymentStatus).toBe("PENDING");
      const [storedUsage] = await getDb().select().from(sponsorshipUsages).where(eq(sponsorshipUsages.id, usage.id));
      expect(storedUsage!.amountApplied).toBe(100);
      expect(await paidCount(gala.id)).toBe(0);
    });

    it("rolls back when a paid place is not free", async () => {
      const { event, gala, registration } = await sponsoredFixture({ galaCapacity: 1 });
      await getDb().update(eventAccess).set({ paidCount: 1 }).where(eq(eventAccess.id, gala.id));
      await expect(withLockingTxn((tx) => settleRegistrationTxn(tx, registration.id, { now: NOW }))).rejects.toBeInstanceOf(
        AccessCapacityExceededError,
      );
      expect((await readRegistration(registration.id)).paymentStatus).toBe("PENDING");
      expect(await paidCount(gala.id)).toBe(1);
      expect(event.id).toBeTruthy();
    });

    it("applies an explicit status and paid amount", async () => {
      const { gala, registration } = await sponsoredFixture();
      // Without the sponsorship the net is 500; with it, 0. An admin marks it PAID with nothing paid.
      const result = await withLockingTxn((tx) =>
        settleRegistrationTxn(tx, registration.id, { paymentStatus: "PAID", paidAmount: 0, paidAt: NOW, now: NOW }),
      );
      expect(result?.after).toMatchObject({ paymentStatus: "PAID", paidAt: NOW, paidAmount: 0 });
      expect(await readRegistration(registration.id)).toMatchObject({ paymentStatus: "PAID", paidAt: NOW, paidAmount: 0 });
      expect(await paidCount(gala.id)).toBe(1);
    });

    it("returns null for a missing registration", async () => {
      expect(await withLockingTxn((tx) => settleRegistrationTxn(tx, "missing"))).toBeNull();
    });
  });
});
