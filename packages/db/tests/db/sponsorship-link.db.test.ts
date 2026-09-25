import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  SponsorshipSettlementError,
  changeSponsorshipCoverageTxn,
  eventAccess,
  getDb,
  linkSponsorshipToRegistrationTxn,
  registrations,
  releaseSponsorshipTxn,
  settleSponsorshipStatusTxn,
  sponsorshipUsages,
  sponsorships,
  unlinkSponsorshipFromRegistrationTxn,
  withLockingTxn,
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
} from "../helpers/factories";

// Plan 2.8: admin link, unlink, cancel/delete and coverage changes lock the
// sponsorship, then its registrations, and settle each registration through
// settleRegistrationTxn. Settled registrations refuse (no REFUNDED revival,
// no PAID drift); paid places follow the settled status.

type Item = { accessId: string; subtotal: number };

function breakdown(base: number, items: Item[] = [], lines: Array<{ code: string; amount: number }> = []) {
  const accessItems = items.map((item) => ({
    accessId: item.accessId,
    name: item.accessId,
    unitPrice: item.subtotal,
    quantity: 1,
    subtotal: item.subtotal,
  }));
  const accessTotal = accessItems.reduce((sum, item) => sum + item.subtotal, 0);
  const subtotal = base + accessTotal;
  const sponsorshipTotal = Math.min(
    lines.reduce((sum, line) => sum + line.amount, 0),
    subtotal,
  );
  return {
    basePrice: base,
    appliedRules: [],
    calculatedBasePrice: base,
    accessItems,
    accessTotal,
    subtotal,
    sponsorships: lines.map((line) => ({ ...line, valid: true })),
    sponsorshipTotal,
    total: subtotal - sponsorshipTotal,
    currency: "TND",
    droppedAccessItems: [],
  };
}

async function scenario() {
  const event = await seedEvent({ status: "OPEN" });
  const form = await seedForm({ eventId: event.id });
  const batch = await seedSponsorshipBatch({ eventId: event.id, formId: form.id });
  const workshop = await seedEventAccess({ eventId: event.id, name: "Workshop", price: 200, registeredCount: 3 });
  return { event, form, batch, workshop };
}

type Scenario = Awaited<ReturnType<typeof scenario>>;

async function registrationOf(
  s: Scenario,
  options: {
    items?: Item[];
    status?: "PENDING" | "PARTIAL" | "PAID" | "WAIVED" | "REFUNDED" | "VERIFYING" | "SPONSORED";
    paidAmount?: number;
    sponsorshipAmount?: number;
    lines?: Array<{ code: string; amount: number }>;
    sponsorshipCode?: string | null;
    paymentMethod?: "LAB_SPONSORSHIP" | "BANK_TRANSFER" | null;
    eventId?: string;
    formId?: string;
  } = {},
) {
  const pb = breakdown(500, options.items ?? [], options.lines ?? []);
  return seedRegistration({
    eventId: options.eventId ?? s.event.id,
    formId: options.formId ?? s.form.id,
    paymentStatus: options.status ?? "PENDING",
    paidAmount: options.paidAmount ?? 0,
    paidAt: ["PAID", "SPONSORED", "WAIVED"].includes(options.status ?? "") ? new Date() : null,
    totalAmount: pb.subtotal,
    baseAmount: pb.calculatedBasePrice,
    accessAmount: pb.accessTotal,
    sponsorshipAmount: options.sponsorshipAmount ?? pb.sponsorshipTotal,
    priceBreakdown: pb,
    accessTypeIds: (options.items ?? []).map((item) => item.accessId),
    sponsorshipCode: options.sponsorshipCode ?? null,
    paymentMethod: options.paymentMethod ?? null,
  });
}

function sponsorshipOf(
  s: Scenario,
  options: { coversBasePrice?: boolean; coveredAccessIds?: string[]; totalAmount: number; status?: "PENDING" | "USED" | "CANCELLED"; code?: string },
) {
  return seedSponsorship({
    batchId: s.batch.id,
    eventId: s.event.id,
    coversBasePrice: options.coversBasePrice ?? true,
    coveredAccessIds: options.coveredAccessIds ?? [],
    totalAmount: options.totalAmount,
    status: options.status ?? "PENDING",
    ...(options.code ? { code: options.code } : {}),
  });
}

async function readRegistration(id: string) {
  const [row] = await getDb().select().from(registrations).where(eq(registrations.id, id));
  return row!;
}

async function readSponsorship(id: string) {
  const [row] = await getDb().select().from(sponsorships).where(eq(sponsorships.id, id));
  return row!;
}

async function usagesOf(registrationId: string) {
  return getDb()
    .select({ sponsorshipId: sponsorshipUsages.sponsorshipId, amountApplied: sponsorshipUsages.amountApplied })
    .from(sponsorshipUsages)
    .where(eq(sponsorshipUsages.registrationId, registrationId))
    .orderBy(asc(sponsorshipUsages.sponsorshipId));
}

async function paidCount(accessId: string): Promise<number> {
  const [row] = await getDb().select({ paidCount: eventAccess.paidCount }).from(eventAccess).where(eq(eventAccess.id, accessId));
  return row!.paidCount;
}

function link(sponsorshipId: string, registrationId: string) {
  return withLockingTxn((tx) =>
    linkSponsorshipToRegistrationTxn(tx, {
      sponsorshipId,
      registrationId,
      appliedBy: "admin-1",
      fields: { paymentMethod: "LAB_SPONSORSHIP" },
    }),
  );
}

function unlink(sponsorshipId: string, registrationId: string) {
  return withLockingTxn((tx) => unlinkSponsorshipFromRegistrationTxn(tx, { sponsorshipId, registrationId }));
}

async function refusal(promise: Promise<unknown>): Promise<SponsorshipSettlementError> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(SponsorshipSettlementError);
  return error as SponsorshipSettlementError;
}

describe.runIf(dbTestsEnabled())("db tier: sponsorship link / unlink / release / coverage", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  describe("link", () => {
    it("a fully covering link settles SPONSORED, takes every paid place and sets the sponsorship USED", async () => {
      const s = await scenario();
      const reg = await registrationOf(s, { items: [{ accessId: s.workshop.id, subtotal: 200 }] });
      const sponsorship = await sponsorshipOf(s, { coveredAccessIds: [s.workshop.id], totalAmount: 700 });

      const result = await link(sponsorship.id, reg.id);

      expect(result.usage.amountApplied).toBe(700);
      expect(result.settled.after).toMatchObject({ paymentStatus: "SPONSORED", sponsorshipAmount: 700 });
      const row = await readRegistration(reg.id);
      expect(row).toMatchObject({ paymentStatus: "SPONSORED", sponsorshipAmount: 700, paymentMethod: "LAB_SPONSORSHIP" });
      expect(row.paidAt).not.toBeNull();
      expect(row.priceBreakdown).toMatchObject({ sponsorshipTotal: 700, total: 0 });
      expect(await paidCount(s.workshop.id)).toBe(1);
      expect((await readSponsorship(sponsorship.id)).status).toBe("USED");
    });

    it("a partial link settles PARTIAL and takes only the covered item's paid place", async () => {
      const s = await scenario();
      const other = await seedEventAccess({ eventId: s.event.id, name: "Dinner", price: 100, registeredCount: 1 });
      const reg = await registrationOf(s, {
        items: [
          { accessId: s.workshop.id, subtotal: 200 },
          { accessId: other.id, subtotal: 100 },
        ],
      });
      const sponsorship = await sponsorshipOf(s, { coversBasePrice: false, coveredAccessIds: [s.workshop.id], totalAmount: 200 });

      await link(sponsorship.id, reg.id);

      expect(await readRegistration(reg.id)).toMatchObject({ paymentStatus: "PARTIAL", sponsorshipAmount: 200, paidAt: null });
      expect(await paidCount(s.workshop.id)).toBe(1);
      expect(await paidCount(other.id)).toBe(0);
    });

    it.each(["PAID", "WAIVED", "REFUNDED"] as const)("refuses a %s registration and changes nothing", async (status) => {
      const s = await scenario();
      const reg = await registrationOf(s, { status, paidAmount: status === "WAIVED" ? 0 : 500 });
      const sponsorship = await sponsorshipOf(s, { totalAmount: 500 });

      const err = await refusal(link(sponsorship.id, reg.id));

      expect(err.reason).toBe("TARGET_SETTLED");
      expect(err.details).toMatchObject({ registrationId: reg.id, paymentStatus: status });
      expect(await readRegistration(reg.id)).toMatchObject({ paymentStatus: status, sponsorshipAmount: 0 });
      expect(await usagesOf(reg.id)).toEqual([]);
      expect((await readSponsorship(sponsorship.id)).status).toBe("PENDING");
    });

    it("refuses a sponsorship that would leave the registration paid more than it owes", async () => {
      const s = await scenario();
      const reg = await registrationOf(s, { status: "PARTIAL", paidAmount: 400 });
      const sponsorship = await sponsorshipOf(s, { totalAmount: 300 });

      const err = await refusal(link(sponsorship.id, reg.id));

      expect(err.reason).toBe("EXCEEDS_AMOUNT_DUE");
      expect(err.details).toMatchObject({ paidAmount: 400, amountDue: 200 });
      expect(await usagesOf(reg.id)).toEqual([]);
    });

    it("refuses a coverage that applies nothing, a cancelled sponsorship, a repeat link and another event", async () => {
      const s = await scenario();
      const reg = await registrationOf(s);
      const unrelated = await sponsorshipOf(s, { coversBasePrice: false, coveredAccessIds: [s.workshop.id], totalAmount: 200 });
      const cancelled = await sponsorshipOf(s, { totalAmount: 100, status: "CANCELLED" });
      const once = await sponsorshipOf(s, { totalAmount: 100 });
      const otherEvent = await seedEvent({ status: "OPEN" });
      const otherForm = await seedForm({ eventId: otherEvent.id });
      const foreign = await registrationOf(s, { eventId: otherEvent.id, formId: otherForm.id });

      expect((await refusal(link(unrelated.id, reg.id))).reason).toBe("NOT_APPLICABLE");
      expect((await refusal(link(cancelled.id, reg.id))).reason).toBe("SPONSORSHIP_CANCELLED");
      await link(once.id, reg.id);
      expect((await refusal(link(once.id, reg.id))).reason).toBe("ALREADY_LINKED");
      expect((await refusal(link(once.id, foreign.id))).reason).toBe("EVENT_MISMATCH");
      expect(await readRegistration(reg.id)).toMatchObject({ sponsorshipAmount: 100 });
    });
  });

  describe("unlink", () => {
    it("the last unlink settles PENDING, releases the paid places, clears the signup code and the LAB method", async () => {
      const s = await scenario();
      const sponsorship = await sponsorshipOf(s, { coveredAccessIds: [s.workshop.id], totalAmount: 700, code: "SP-UNLINK01" });
      const reg = await registrationOf(s, {
        items: [{ accessId: s.workshop.id, subtotal: 200 }],
        sponsorshipCode: " sp-unlink01",
        lines: [{ code: "SP-UNLINK01", amount: 700 }],
      });
      await link(sponsorship.id, reg.id);
      expect(await paidCount(s.workshop.id)).toBe(1);

      const result = await unlink(sponsorship.id, reg.id);

      expect(result).toMatchObject({
        clearedSponsorshipCode: " sp-unlink01",
        clearedPaymentMethod: "LAB_SPONSORSHIP",
        status: { before: "USED", after: "PENDING" },
      });
      const row = await readRegistration(reg.id);
      expect(row).toMatchObject({
        paymentStatus: "PENDING",
        sponsorshipAmount: 0,
        paidAt: null,
        sponsorshipCode: null,
        paymentMethod: null,
        totalAmount: 700,
      });
      // The signup code's breakdown line goes with it; the amount is not kept as an unlinked signup amount.
      expect(row.priceBreakdown).toMatchObject({ sponsorships: [], sponsorshipTotal: 0, total: 700 });
      expect(await paidCount(s.workshop.id)).toBe(0);
      expect((await readSponsorship(sponsorship.id)).status).toBe("PENDING");
    });

    it("keeps another sponsorship's amount, another code and a payment method other than LAB_SPONSORSHIP", async () => {
      const s = await scenario();
      const first = await sponsorshipOf(s, { totalAmount: 300 });
      const second = await sponsorshipOf(s, { totalAmount: 100 });
      const reg = await registrationOf(s, { sponsorshipCode: "SP-SOMEOTHER" });
      await link(first.id, reg.id);
      await link(second.id, reg.id);

      const result = await unlink(first.id, reg.id);

      expect(result).toMatchObject({ clearedSponsorshipCode: null, clearedPaymentMethod: null });
      expect(await readRegistration(reg.id)).toMatchObject({
        paymentStatus: "PARTIAL",
        sponsorshipAmount: 100,
        sponsorshipCode: "SP-SOMEOTHER",
        paymentMethod: "LAB_SPONSORSHIP",
      });
      expect(await usagesOf(reg.id)).toEqual([{ sponsorshipId: second.id, amountApplied: 100 }]);

      // The last unlink clears only a LAB_SPONSORSHIP method.
      await getDb().update(registrations).set({ paymentMethod: "BANK_TRANSFER" }).where(eq(registrations.id, reg.id));
      expect(await unlink(second.id, reg.id)).toMatchObject({ clearedPaymentMethod: null });
      expect(await readRegistration(reg.id)).toMatchObject({
        paymentStatus: "PENDING",
        sponsorshipAmount: 0,
        paymentMethod: "BANK_TRANSFER",
      });
    });

    it("refuses to change a PAID registration's amount", async () => {
      const s = await scenario();
      const sponsorship = await sponsorshipOf(s, { totalAmount: 200 });
      const reg = await registrationOf(s);
      await link(sponsorship.id, reg.id);
      await getDb()
        .update(registrations)
        .set({ paymentStatus: "PAID", paidAmount: 300, paidAt: new Date() })
        .where(eq(registrations.id, reg.id));

      const err = await refusal(unlink(sponsorship.id, reg.id));

      expect(err.reason).toBe("TARGET_SETTLED");
      expect(await usagesOf(reg.id)).toHaveLength(1);
      expect(await readRegistration(reg.id)).toMatchObject({ paymentStatus: "PAID", sponsorshipAmount: 200, paidAmount: 300 });
    });

    it("never revives a REFUNDED registration", async () => {
      const s = await scenario();
      const sponsorship = await sponsorshipOf(s, { totalAmount: 500 });
      const reg = await registrationOf(s);
      await link(sponsorship.id, reg.id);
      await getDb().update(registrations).set({ paymentStatus: "REFUNDED" }).where(eq(registrations.id, reg.id));

      await unlink(sponsorship.id, reg.id);

      expect(await readRegistration(reg.id)).toMatchObject({ paymentStatus: "REFUNDED", sponsorshipAmount: 0 });
    });

    it("NOT_LINKED when there is no such usage", async () => {
      const s = await scenario();
      const sponsorship = await sponsorshipOf(s, { totalAmount: 500 });
      const reg = await registrationOf(s);
      expect((await refusal(unlink(sponsorship.id, reg.id))).reason).toBe("NOT_LINKED");
    });
  });

  describe("release (cancel / delete)", () => {
    it("unlinks every registration in ascending order; CANCELLED stays CANCELLED", async () => {
      const s = await scenario();
      const sponsorship = await sponsorshipOf(s, { totalAmount: 500 });
      const [a, b] = [await registrationOf(s), await registrationOf(s)];
      await link(sponsorship.id, a.id);
      await link(sponsorship.id, b.id);
      await getDb().update(sponsorships).set({ status: "CANCELLED" }).where(eq(sponsorships.id, sponsorship.id));

      const released = await withLockingTxn(async (tx) => {
        const result = await releaseSponsorshipTxn(tx, sponsorship.id);
        const status = await settleSponsorshipStatusTxn(tx, result!.sponsorship);
        return { result, status };
      });

      expect(released.result!.unlinked.map((u) => u.registrationId)).toEqual([a.id, b.id].sort());
      expect(released.status).toEqual({ before: "CANCELLED", after: "CANCELLED" });
      expect(await readRegistration(a.id)).toMatchObject({ paymentStatus: "PENDING", sponsorshipAmount: 0 });
      expect(await readRegistration(b.id)).toMatchObject({ paymentStatus: "PENDING", sponsorshipAmount: 0 });
      expect((await readSponsorship(sponsorship.id)).status).toBe("CANCELLED");
    });

    it("rolls back every unlink when one linked registration is PAID", async () => {
      const s = await scenario();
      const sponsorship = await sponsorshipOf(s, { totalAmount: 200 });
      const [a, b] = [await registrationOf(s), await registrationOf(s)];
      await link(sponsorship.id, a.id);
      await link(sponsorship.id, b.id);
      await getDb()
        .update(registrations)
        .set({ paymentStatus: "PAID", paidAmount: 300, paidAt: new Date() })
        .where(eq(registrations.id, b.id));

      const err = await refusal(withLockingTxn((tx) => releaseSponsorshipTxn(tx, sponsorship.id)));

      expect(err.details.registrationId).toBe(b.id);
      expect(await usagesOf(a.id)).toHaveLength(1);
      expect(await readRegistration(a.id)).toMatchObject({ sponsorshipAmount: 200, paymentStatus: "PARTIAL" });
    });
  });

  describe("coverage change", () => {
    it("recomputes the usage against the new coverage and settles the registration", async () => {
      const s = await scenario();
      const reg = await registrationOf(s, { items: [{ accessId: s.workshop.id, subtotal: 200 }] });
      const sponsorship = await sponsorshipOf(s, { totalAmount: 500 });
      await link(sponsorship.id, reg.id);
      expect(await readRegistration(reg.id)).toMatchObject({ paymentStatus: "PARTIAL", sponsorshipAmount: 500 });
      expect(await paidCount(s.workshop.id)).toBe(0);

      const changed = await withLockingTxn((tx) =>
        changeSponsorshipCoverageTxn(
          tx,
          sponsorship.id,
          { coversBasePrice: true, coveredAccessIds: [s.workshop.id], totalAmount: 700 },
          { beneficiaryName: "Renamed" },
        ),
      );

      expect(changed!.settled.map((r) => r.registrationId)).toEqual([reg.id]);
      expect(await readRegistration(reg.id)).toMatchObject({ paymentStatus: "SPONSORED", sponsorshipAmount: 700 });
      expect(await usagesOf(reg.id)).toEqual([{ sponsorshipId: sponsorship.id, amountApplied: 700 }]);
      expect(await paidCount(s.workshop.id)).toBe(1);
      expect(await readSponsorship(sponsorship.id)).toMatchObject({ totalAmount: 700, beneficiaryName: "Renamed" });
    });

    it("refuses when a PAID registration's amount would change, and keeps the old coverage", async () => {
      const s = await scenario();
      const reg = await registrationOf(s);
      const sponsorship = await sponsorshipOf(s, { totalAmount: 200 });
      await link(sponsorship.id, reg.id);
      await getDb()
        .update(registrations)
        .set({ paymentStatus: "PAID", paidAmount: 300, paidAt: new Date() })
        .where(eq(registrations.id, reg.id));

      const err = await refusal(
        withLockingTxn((tx) =>
          changeSponsorshipCoverageTxn(tx, sponsorship.id, { coversBasePrice: true, coveredAccessIds: [], totalAmount: 400 }),
        ),
      );

      expect(err.reason).toBe("TARGET_SETTLED");
      expect((await readSponsorship(sponsorship.id)).totalAmount).toBe(200);
      expect(await readRegistration(reg.id)).toMatchObject({ sponsorshipAmount: 200, paymentStatus: "PAID" });
    });
  });
});
