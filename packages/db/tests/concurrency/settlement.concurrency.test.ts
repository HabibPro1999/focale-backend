import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  getDb,
  linkSponsorshipToRegistrationTxn,
  lockRegistrationForUpdate,
  registrations,
  releaseSponsorshipTxn,
  sponsorshipUsages,
  sponsorships,
  unlinkSponsorshipFromRegistrationTxn,
  withLockingTxn,
  withTxn,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import {
  seedEvent,
  seedForm,
  seedRegistration,
  seedSponsorship,
  seedSponsorshipBatch,
} from "../helpers/factories";

// Settlement under concurrency (plan 2.8). Linking a sponsorship recomputes the
// registration's sponsorship amount from all of its usages. The real link and
// unlink functions lock the sponsorship, then the registration, before that
// read-modify-write, so concurrent changes to one registration queue and each
// sees the other's usage: no lost update.

function breakdown(base: number) {
  return {
    basePrice: base,
    appliedRules: [],
    calculatedBasePrice: base,
    accessItems: [],
    accessTotal: 0,
    subtotal: base,
    sponsorships: [],
    sponsorshipTotal: 0,
    total: base,
    currency: "TND",
    droppedAccessItems: [],
  };
}

async function seedScenario(registrationCount: number, sponsorAmounts: number[]) {
  const event = await seedEvent({ status: "OPEN" });
  const form = await seedForm({ eventId: event.id });
  const regs = [];
  for (let i = 0; i < registrationCount; i++) {
    regs.push(
      await seedRegistration({
        eventId: event.id,
        formId: form.id,
        totalAmount: 1000,
        baseAmount: 1000,
        priceBreakdown: breakdown(1000),
      }),
    );
  }
  const batch = await seedSponsorshipBatch({ eventId: event.id, formId: form.id });
  const sponsors = [];
  for (const amount of sponsorAmounts) {
    // coversBasePrice with a smaller totalAmount: the sponsorship applies `amount`.
    sponsors.push(
      await seedSponsorship({ batchId: batch.id, eventId: event.id, totalAmount: amount, coversBasePrice: true }),
    );
  }
  return { registrations: regs, sponsorships: sponsors };
}

async function readRegistration(id: string) {
  const [row] = await getDb().select().from(registrations).where(eq(registrations.id, id));
  return row;
}

async function usagesOf(registrationId: string) {
  return getDb()
    .select({ sponsorshipId: sponsorshipUsages.sponsorshipId, amountApplied: sponsorshipUsages.amountApplied })
    .from(sponsorshipUsages)
    .where(eq(sponsorshipUsages.registrationId, registrationId))
    .orderBy(asc(sponsorshipUsages.sponsorshipId));
}

async function statusOf(sponsorshipId: string) {
  const [row] = await getDb()
    .select({ status: sponsorships.status })
    .from(sponsorships)
    .where(eq(sponsorships.id, sponsorshipId));
  return row.status;
}

function link(sponsorshipId: string, registrationId: string) {
  return withLockingTxn((tx) =>
    linkSponsorshipToRegistrationTxn(tx, { sponsorshipId, registrationId, appliedBy: "concurrency-test" }),
  );
}

function unlink(sponsorshipId: string, registrationId: string) {
  return withLockingTxn((tx) => unlinkSponsorshipFromRegistrationTxn(tx, { sponsorshipId, registrationId }));
}

/** True when `promise` settles within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true, () => true), sleep(ms).then(() => false)]);
}

/**
 * Hold the registration's row lock, start every change, check none can
 * finish while the lock is held, then release it and wait for all of them.
 */
async function queuedBehindRegistrationLock(registrationId: string, changes: Array<() => Promise<unknown>>) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const holder = withTxn(async (tx) => {
    await lockRegistrationForUpdate(tx, registrationId);
    locked();
    await released;
  });
  await isLocked;
  try {
    const running = changes.map((change) => change());
    for (const promise of running) expect(await settlesWithin(promise, 300)).toBe(false);
    release();
    await holder;
    return await Promise.allSettled(running);
  } finally {
    release();
    await holder.catch(() => undefined);
  }
}

describe.runIf(dbTestsEnabled())("concurrency: sponsorship settlement", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it("two links to one registration both count: no lost update", async () => {
    const { registrations: [reg], sponsorships: [s1, s2] } = await seedScenario(1, [300, 200]);

    const results = await queuedBehindRegistrationLock(reg.id, [() => link(s1.id, reg.id), () => link(s2.id, reg.id)]);

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const row = await readRegistration(reg.id);
    expect(row).toMatchObject({ sponsorshipAmount: 500, paymentStatus: "PARTIAL" });
    expect(row.priceBreakdown).toMatchObject({ sponsorshipTotal: 500, total: 500 });
    expect((await usagesOf(reg.id)).map((usage) => usage.amountApplied).sort()).toEqual([200, 300]);
    expect([await statusOf(s1.id), await statusOf(s2.id)]).toEqual(["USED", "USED"]);
  });

  it("a link and an unlink on one registration settle to the remaining usage", async () => {
    const { registrations: [reg], sponsorships: [s1, s2] } = await seedScenario(1, [300, 200]);
    await link(s1.id, reg.id);

    const results = await queuedBehindRegistrationLock(reg.id, [() => link(s2.id, reg.id), () => unlink(s1.id, reg.id)]);

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const row = await readRegistration(reg.id);
    expect(row).toMatchObject({ sponsorshipAmount: 200, paymentStatus: "PARTIAL" });
    expect(await usagesOf(reg.id)).toEqual([{ sponsorshipId: s2.id, amountApplied: 200 }]);
    expect([await statusOf(s1.id), await statusOf(s2.id)]).toEqual(["PENDING", "USED"]);
  });

  it("parallel links of many sponsorships to one registration sum exactly", async () => {
    const amounts = [100, 110, 120, 130, 140];
    const { registrations: [reg], sponsorships: sponsors } = await seedScenario(1, amounts);

    const results = await Promise.allSettled(sponsors.map((s) => link(s.id, reg.id)));

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await readRegistration(reg.id)).toMatchObject({ sponsorshipAmount: 600, paymentStatus: "PARTIAL" });
    expect(await usagesOf(reg.id)).toHaveLength(amounts.length);
  });

  it("releasing a sponsorship while others link to the same registrations does not deadlock", async () => {
    const { registrations: [r1, r2], sponsorships: [s1, s2, s3] } = await seedScenario(2, [300, 200, 100]);
    await link(s1.id, r1.id);
    await link(s1.id, r2.id);

    const results = await Promise.allSettled([
      withLockingTxn((tx) => releaseSponsorshipTxn(tx, s1.id)),
      link(s2.id, r2.id),
      link(s3.id, r1.id),
    ]);

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    expect(await readRegistration(r1.id)).toMatchObject({ sponsorshipAmount: 100 });
    expect(await readRegistration(r2.id)).toMatchObject({ sponsorshipAmount: 200 });
    expect(await usagesOf(r1.id)).toEqual([{ sponsorshipId: s3.id, amountApplied: 100 }]);
  });
});
