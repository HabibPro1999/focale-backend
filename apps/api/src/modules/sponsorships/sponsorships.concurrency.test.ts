import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { ErrorCodes } from "@app/contracts";
import { findRegistrationForMutation, lockRegistrationForUpdate, withTxn } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import {
  seedEvent,
  seedForm,
  seedRegistration,
  seedSponsorship,
  seedSponsorshipBatch,
} from "../../../../../packages/db/tests/helpers/factories";
import {
  readSponsorshipRow,
  sponsorshipUsagesOf,
} from "../../../../../packages/db/tests/helpers/sponsorship-inspect";
import { AccessService } from "../access/access.service";
import { RegistrationPaymentsService } from "../registrations/registrations.payments.service";
import { RegistrationSideEffects } from "../registrations/registrations.side-effects";
import { SponsorshipsAdminService } from "./sponsorships.admin.service";

// Plan 2.8: a sponsorship link or unlink and a payment confirmation on the
// same registration both lock the registration row first, so whichever runs
// second decides from what the first committed. The registration never ends
// PAID for an amount other than what it owes, and a lost race is a 4xx.

const access = new AccessService();
const registrationPayments = new RegistrationPaymentsService(
  access,
  new RegistrationSideEffects(access),
);
const sponsorshipsService = new SponsorshipsAdminService(access);

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

/** A PENDING 500 registration and a 200 base-price sponsorship of the same event. */
async function scenario() {
  const event = await seedEvent({ status: "OPEN", endDate: new Date("2099-01-01T00:00:00.000Z") });
  const form = await seedForm({ eventId: event.id });
  const registration = await seedRegistration({
    eventId: event.id,
    formId: form.id,
    paymentStatus: "PENDING",
    totalAmount: 500,
    baseAmount: 500,
    priceBreakdown: breakdown(500),
  });
  const batch = await seedSponsorshipBatch({ eventId: event.id, formId: form.id });
  const sponsorship = await seedSponsorship({
    batchId: batch.id,
    eventId: event.id,
    coversBasePrice: true,
    totalAmount: 200,
  });
  return { registration, sponsorship };
}

async function readRegistration(id: string) {
  const row = await withTxn((tx) => findRegistrationForMutation(id, tx));
  if (!row) throw new Error(`registration ${id} not found`);
  return row;
}

/**
 * The settlement invariants every interleaving must keep, given every
 * sponsorship that may be linked to the registration.
 */
async function expectConsistent(registrationId: string, sponsorshipIds: string[]) {
  const row = await readRegistration(registrationId);
  let linkedTotal = 0;
  for (const sponsorshipId of sponsorshipIds) {
    const linked = (await sponsorshipUsagesOf(sponsorshipId)).filter((usage) => usage.registrationId === registrationId);
    linkedTotal += linked.reduce((sum, usage) => sum + usage.amountApplied, 0);
    expect((await readSponsorshipRow(sponsorshipId)).status).toBe(linked.length > 0 ? "USED" : "PENDING");
  }
  expect(row.sponsorshipAmount).toBe(linkedTotal);
  expect(row.paidAmount).toBeLessThanOrEqual(row.totalAmount - row.sponsorshipAmount);
  if (row.paymentStatus === "PAID") {
    expect(row.paidAmount).toBe(row.totalAmount - row.sponsorshipAmount);
  }
  return row;
}

/** True when `promise` settles within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true, () => true), sleep(ms).then(() => false)]);
}

/**
 * Hold the registration's row lock, start `first` and wait until it is
 * blocked behind it, then `second`, so both queue in that order; then
 * release the lock.
 */
async function queueBehindLock<A, B>(registrationId: string, first: () => Promise<A>, second: () => Promise<B>) {
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
    const a = first();
    expect(await settlesWithin(a, 400)).toBe(false);
    const b = second();
    expect(await settlesWithin(b, 400)).toBe(false);
    release();
    await holder;
    return await Promise.allSettled([a, b]);
  } finally {
    release();
    await holder.catch(() => undefined);
  }
}

const confirm = (registrationId: string) =>
  registrationPayments.confirmPayment(registrationId, { paymentStatus: "PAID" }, "admin-1");

describe.runIf(dbTestsEnabled())("sponsorship link/unlink vs payment confirmation", () => {
  it("link, then confirm: the confirmation is for the sponsored net", async () => {
    const { registration, sponsorship } = await scenario();

    const [linked, confirmed] = await queueBehindLock(
      registration.id,
      () => sponsorshipsService.linkSponsorshipToRegistration(sponsorship.id, registration.id, "admin-1"),
      () => confirm(registration.id),
    );

    expect([linked.status, confirmed.status]).toEqual(["fulfilled", "fulfilled"]);
    const row = await expectConsistent(registration.id, [sponsorship.id]);
    expect(row).toMatchObject({ paymentStatus: "PAID", paidAmount: 300, sponsorshipAmount: 200 });
  });

  it("confirm, then link: the link is refused with 409 and the payment stays whole", async () => {
    const { registration, sponsorship } = await scenario();

    const [confirmed, linked] = await queueBehindLock(
      registration.id,
      () => confirm(registration.id),
      () => sponsorshipsService.linkSponsorshipToRegistration(sponsorship.id, registration.id, "admin-1"),
    );

    expect(confirmed.status).toBe("fulfilled");
    expect(linked.status).toBe("rejected");
    expect((linked as PromiseRejectedResult).reason).toMatchObject({
      code: ErrorCodes.SPONSORSHIP_TARGET_SETTLED,
      statusCode: 409,
    });
    const row = await expectConsistent(registration.id, [sponsorship.id]);
    expect(row).toMatchObject({ paymentStatus: "PAID", paidAmount: 500, sponsorshipAmount: 0 });
  });

  it("unlink, then confirm: the confirmation is for the full price", async () => {
    const { registration, sponsorship } = await scenario();
    await sponsorshipsService.linkSponsorshipToRegistration(sponsorship.id, registration.id, "admin-1");

    const [unlinked, confirmed] = await queueBehindLock(
      registration.id,
      () => sponsorshipsService.unlinkSponsorshipFromRegistration(sponsorship.id, registration.id, "admin-1"),
      () => confirm(registration.id),
    );

    expect([unlinked.status, confirmed.status]).toEqual(["fulfilled", "fulfilled"]);
    const row = await expectConsistent(registration.id, [sponsorship.id]);
    expect(row).toMatchObject({ paymentStatus: "PAID", paidAmount: 500, sponsorshipAmount: 0 });
  });

  it("confirm, then unlink: the unlink is refused with 409 and the sponsorship stays linked", async () => {
    const { registration, sponsorship } = await scenario();
    await sponsorshipsService.linkSponsorshipToRegistration(sponsorship.id, registration.id, "admin-1");

    const [confirmed, unlinked] = await queueBehindLock(
      registration.id,
      () => confirm(registration.id),
      () => sponsorshipsService.unlinkSponsorshipFromRegistration(sponsorship.id, registration.id, "admin-1"),
    );

    expect(confirmed.status).toBe("fulfilled");
    expect((unlinked as PromiseRejectedResult).reason).toMatchObject({
      code: ErrorCodes.SPONSORSHIP_TARGET_SETTLED,
      statusCode: 409,
    });
    const row = await expectConsistent(registration.id, [sponsorship.id]);
    expect(row).toMatchObject({ paymentStatus: "PAID", paidAmount: 300, sponsorshipAmount: 200 });
  });

  it("unordered: a link, an unlink of another sponsorship and a confirmation keep the invariants", async () => {
    const { registration, sponsorship } = await scenario();
    const other = await seedSponsorship({
      batchId: (await readSponsorshipRow(sponsorship.id)).batchId,
      eventId: registration.eventId,
      coversBasePrice: true,
      totalAmount: 100,
    });
    await sponsorshipsService.linkSponsorshipToRegistration(other.id, registration.id, "admin-1");

    const results = await Promise.allSettled([
      sponsorshipsService.linkSponsorshipToRegistration(sponsorship.id, registration.id, "admin-1"),
      sponsorshipsService.unlinkSponsorshipFromRegistration(other.id, registration.id, "admin-1"),
      confirm(registration.id),
    ]);

    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ code: ErrorCodes.SPONSORSHIP_TARGET_SETTLED, statusCode: 409 });
      }
    }
    expect(results[2].status).toBe("fulfilled");
    await expectConsistent(registration.id, [sponsorship.id, other.id]);
  });
});
