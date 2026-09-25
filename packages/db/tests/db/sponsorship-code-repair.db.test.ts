import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  SPONSORSHIP_CODE_REPAIR_ACTOR,
  applySponsorshipCodeLink,
  eventAccess,
  getDb,
  planSponsorshipCodeRepair,
  registrations,
  sponsorships,
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
import {
  auditRowsOf,
  readSponsorshipRow,
  realtimeRowsOf,
  sponsorshipUsagesOf,
} from "../helpers/sponsorship-inspect";

// Plan 2.7: repair of signup codes stored before codes were consumed. The plan
// is read-only; a single-claimant code is linked like a signup; everything
// else goes to the business-decision list.

function breakdown(gala: { id: string; price: number }, sponsorship: number, code: string | null) {
  const subtotal = gala.price;
  return {
    basePrice: 0,
    appliedRules: [],
    calculatedBasePrice: 0,
    accessItems: [{ accessId: gala.id, name: "Gala", unitPrice: gala.price, quantity: 1, subtotal: gala.price }],
    accessTotal: gala.price,
    subtotal,
    sponsorships: code ? [{ code, amount: sponsorship, valid: true }] : [],
    sponsorshipTotal: sponsorship,
    total: subtotal - sponsorship,
    currency: "TND",
    droppedAccessItems: [],
  };
}

async function setup(options: { maxCapacity?: number } = {}) {
  const event = await seedEvent({ status: "OPEN" });
  const form = await seedForm({ eventId: event.id });
  const gala = await seedEventAccess({
    eventId: event.id,
    name: "Gala",
    price: 150,
    registeredCount: 5,
    maxCapacity: options.maxCapacity ?? null,
  });
  const batch = await seedSponsorshipBatch({ eventId: event.id, formId: form.id });
  const sponsorship = await seedSponsorship({
    batchId: batch.id,
    eventId: event.id,
    totalAmount: 500,
    coversBasePrice: true,
    coveredAccessIds: [gala.id],
  });
  return { event, form, gala, batch, sponsorship };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** A registration that stored `code` at signup with its amount but no usage (the pre-2.7 bug). */
function seedLegacyClaimant(s: Setup, values: Parameters<typeof seedRegistration>[0] & { code?: string | null; sponsorship?: number } = {}) {
  const { code = ` ${s.sponsorship.code.toLowerCase()} `, sponsorship = 150, ...rest } = values;
  return seedRegistration({
    eventId: s.event.id,
    formId: s.form.id,
    totalAmount: 150,
    accessAmount: 150,
    accessTypeIds: [s.gala.id],
    sponsorshipCode: code,
    sponsorshipAmount: sponsorship,
    priceBreakdown: breakdown(s.gala, sponsorship, code),
    ...rest,
  });
}

async function readRegistration(id: string) {
  const [row] = await getDb().select().from(registrations).where(eq(registrations.id, id));
  return row!;
}

async function paidCount(accessId: string): Promise<number> {
  const [row] = await getDb().select({ paidCount: eventAccess.paidCount }).from(eventAccess).where(eq(eventAccess.id, accessId));
  return row!.paidCount;
}

describe.runIf(dbTestsEnabled())("db tier: sponsorship code repair (2.7)", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it("links a single-claimant code like a signup, once", async () => {
    const s = await setup();
    const claimant = await seedLegacyClaimant(s);

    const plan = await planSponsorshipCodeRepair();
    expect(plan.decisions).toEqual([]);
    expect(plan.links).toEqual([
      expect.objectContaining({
        eventId: s.event.id,
        code: s.sponsorship.code,
        sponsorshipId: s.sponsorship.id,
        registrationId: claimant.id,
        before: expect.objectContaining({ paymentStatus: "PENDING", sponsorshipAmount: 150 }),
        after: { paymentStatus: "SPONSORED", sponsorshipAmount: 150, amountDue: 0 },
        paidPlaces: { [s.gala.id]: 1 },
        fillsCapacity: [],
      }),
    ]);
    // The plan is read-only.
    expect(await sponsorshipUsagesOf(s.sponsorship.id)).toEqual([]);

    const result = await applySponsorshipCodeLink(plan.links[0]);
    expect(result).toEqual({
      outcome: "linked",
      registrationId: claimant.id,
      paymentStatus: "SPONSORED",
      sponsorshipAmount: 150,
    });
    const row = await readRegistration(claimant.id);
    expect(row).toMatchObject({ paymentStatus: "SPONSORED", sponsorshipAmount: 150 });
    expect(row.paidAt).toBeInstanceOf(Date);
    expect((await readSponsorshipRow(s.sponsorship.id)).status).toBe("USED");
    const usages = await sponsorshipUsagesOf(s.sponsorship.id);
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ registrationId: claimant.id, amountApplied: 150, appliedBy: SPONSORSHIP_CODE_REPAIR_ACTOR });
    expect(await paidCount(s.gala.id)).toBe(1);
    expect((await auditRowsOf("Sponsorship", s.sponsorship.id)).map((a) => a.action)).toEqual(["LINK_TO_REGISTRATION"]);
    expect((await auditRowsOf("Registration", claimant.id)).map((a) => a.action)).toEqual(["DATA_REPAIR_SPONSORSHIP_LINK"]);
    expect(await realtimeRowsOf("sponsorship.linked", s.sponsorship.id)).toHaveLength(1);
    expect(await realtimeRowsOf("registration.paymentConfirmed", claimant.id)).toHaveLength(1);

    // Running it again changes nothing.
    const again = await planSponsorshipCodeRepair();
    expect(again).toEqual({ links: [], decisions: [], alreadyLinked: 1 });
    expect(await applySponsorshipCodeLink(plan.links[0])).toMatchObject({ outcome: "skipped", reason: "STALE" });
    expect(await sponsorshipUsagesOf(s.sponsorship.id)).toHaveLength(1);
    expect(await paidCount(s.gala.id)).toBe(1);
  });

  it("links a PAID claimant whose amount does not change, keeping it PAID", async () => {
    const s = await setup();
    const claimant = await seedLegacyClaimant(s, { sponsorship: 100, paymentStatus: "PAID", paidAmount: 50, paidAt: new Date() });
    // The sponsorship covers the whole gala (150) but the claimant stored 100: an amount change.
    const changed = await planSponsorshipCodeRepair();
    expect(changed.links).toEqual([]);
    expect(changed.decisions).toEqual([
      expect.objectContaining({ reason: "SETTLED_AMOUNT_CHANGE", registrationIds: [claimant.id] }),
    ]);

    await getDb()
      .update(registrations)
      .set({ sponsorshipAmount: 150, paidAmount: 0, priceBreakdown: breakdown(s.gala, 150, s.sponsorship.code) })
      .where(eq(registrations.id, claimant.id));
    const plan = await planSponsorshipCodeRepair();
    expect(plan.links).toHaveLength(1);
    expect(plan.links[0].after.paymentStatus).toBe("PAID");
    expect(await applySponsorshipCodeLink(plan.links[0])).toMatchObject({ outcome: "linked", paymentStatus: "PAID" });
    expect(await readRegistration(claimant.id)).toMatchObject({ paymentStatus: "PAID", sponsorshipAmount: 150 });
  });

  it("sends codes with several claimants, unknown and cancelled codes and orphan amounts to the decision list", async () => {
    const shared = await setup();
    const first = await seedLegacyClaimant(shared);
    const second = await seedLegacyClaimant(shared, { code: shared.sponsorship.code });

    const linkedElsewhere = await setup();
    const claimant = await seedLegacyClaimant(linkedElsewhere);
    const admin = await seedRegistration({ eventId: linkedElsewhere.event.id, formId: linkedElsewhere.form.id });
    await seedSponsorshipUsage({
      sponsorshipId: linkedElsewhere.sponsorship.id,
      registrationId: admin.id,
      amountApplied: 0,
      appliedBy: "admin",
    });

    const unknown = await setup();
    const unknownClaimant = await seedLegacyClaimant(unknown, { code: "sp-nosuch22", sponsorship: 0 });

    const cancelled = await setup();
    await getDb().update(sponsorships).set({ status: "CANCELLED" }).where(eq(sponsorships.id, cancelled.sponsorship.id));
    const cancelledClaimant = await seedLegacyClaimant(cancelled);

    const orphan = await setup();
    const orphanRow = await seedLegacyClaimant(orphan, { code: null, sponsorship: 50 });

    const refunded = await setup();
    const refundedClaimant = await seedLegacyClaimant(refunded, { paymentStatus: "REFUNDED" });

    const plan = await planSponsorshipCodeRepair();
    expect(plan.links).toEqual([]);
    const byReason = Object.fromEntries(plan.decisions.map((d) => [`${d.reason}:${d.eventId}`, d.registrationIds]));
    expect(byReason).toEqual({
      [`SEVERAL_CLAIMANTS:${shared.event.id}`]: [first.id, second.id].sort(),
      [`SEVERAL_CLAIMANTS:${linkedElsewhere.event.id}`]: [admin.id, claimant.id].sort(),
      [`UNKNOWN_CODE:${unknown.event.id}`]: [unknownClaimant.id],
      [`CANCELLED_CODE:${cancelled.event.id}`]: [cancelledClaimant.id],
      [`AMOUNT_WITHOUT_CODE:${orphan.event.id}`]: [orphanRow.id],
      [`REFUNDED_CLAIMANT:${refunded.event.id}`]: [refundedClaimant.id],
    });

    // Scoped to one event.
    const scoped = await planSponsorshipCodeRepair({ eventId: unknown.event.id });
    expect(scoped.decisions.map((d) => d.reason)).toEqual(["UNKNOWN_CODE"]);
  });

  it("skips a link whose registration changed since the plan, writing nothing", async () => {
    const s = await setup();
    const claimant = await seedLegacyClaimant(s);
    const [link] = (await planSponsorshipCodeRepair()).links;
    await getDb().update(registrations).set({ note: "edited" }).where(eq(registrations.id, claimant.id));

    expect(await applySponsorshipCodeLink(link)).toMatchObject({ outcome: "skipped", reason: "STALE" });
    expect(await sponsorshipUsagesOf(s.sponsorship.id)).toEqual([]);
    expect((await readSponsorshipRow(s.sponsorship.id)).status).toBe("PENDING");
    expect(await readRegistration(claimant.id)).toMatchObject({ paymentStatus: "PENDING" });
  });

  it("skips a link that would fill an access item until the 2.8 capacity drop exists", async () => {
    const s = await setup({ maxCapacity: 1 });
    await seedLegacyClaimant(s);
    const [link] = (await planSponsorshipCodeRepair()).links;
    expect(link.fillsCapacity).toEqual([s.gala.id]);

    expect(await applySponsorshipCodeLink(link)).toMatchObject({ outcome: "skipped", reason: "FILLS_CAPACITY" });
    expect(await sponsorshipUsagesOf(s.sponsorship.id)).toEqual([]);
    expect(await paidCount(s.gala.id)).toBe(0);
  });
});
