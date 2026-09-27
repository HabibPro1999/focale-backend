import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "@app/contracts";
import { findRegistrationForMutation, getDb, lockRegistrationForUpdate, outboxEvents, upsertEventPricing, withTxn } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import {
  seedEvent,
  seedForm,
  seedRegistration,
  seedSponsorship,
  seedSponsorshipBatch,
} from "../../../../../packages/db/tests/helpers/factories";
import {
  auditRowsOf,
  readSponsorshipRow,
  realtimeRowsOf,
  sponsorshipUsagesOf,
} from "../../../../../packages/db/tests/helpers/sponsorship-inspect";
import * as rowLocks from "../../../../../packages/db/src/locks";
import { AccessService } from "../access/access.service";
import { RegistrationPaymentsService } from "../registrations/registrations.payments.service";
import { RegistrationSideEffects } from "../registrations/registrations.side-effects";
import { SponsorshipsAdminService } from "./sponsorships.admin.service";

// Plan 2.8: a sponsorship link or unlink and a payment confirmation on the
// same registration serialize settlement through its row lock and re-read,
// so whichever runs second decides from what the first committed. The registration never ends
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


/** Full money/breakdown checks for the additional current-policy races. */
function expectNetBreakdown(row: Awaited<ReturnType<typeof readRegistration>>, sponsorship: number) {
  expect(row.totalAmount).toBe(500);
  expect(row.sponsorshipAmount).toBe(sponsorship);
  expect(row.priceBreakdown).toEqual({
    ...breakdown(500),
    sponsorshipTotal: sponsorship,
    total: 500 - sponsorship,
  });
}

async function anotherSponsorship(
  registration: Awaited<ReturnType<typeof scenario>>["registration"],
  first: Awaited<ReturnType<typeof scenario>>["sponsorship"],
) {
  return seedSponsorship({
    batchId: first.batchId,
    eventId: registration.eventId,
    coversBasePrice: true,
    totalAmount: 100,
  });
}

describe.runIf(dbTestsEnabled())("sponsorship service races beyond payment confirmation", () => {
  it("two links serialize through the API and commit both responses, audits and sponsorship emails", async () => {
    const { registration, sponsorship } = await scenario();
    const other = await anotherSponsorship(registration, sponsorship);

    const [first, second] = await queueBehindLock(
      registration.id,
      () => sponsorshipsService.linkSponsorshipToRegistration(sponsorship.id, registration.id, "race-link-first"),
      () => sponsorshipsService.linkSponsorshipToRegistration(other.id, registration.id, "race-link-second"),
    );

    expect([first.status, second.status]).toEqual(["fulfilled", "fulfilled"]);
    if (first.status !== "fulfilled" || second.status !== "fulfilled") {
      throw new Error("Both links to the initially PENDING registration must succeed");
    }
    // Both calls were blocked, but lock scheduling/retries need not be FIFO.
    // Each response describes its own serialized write, in either valid order.
    expect([[200, 300], [300, 100]]).toContainEqual([
      first.value.registration.sponsorshipAmount,
      second.value.registration.sponsorshipAmount,
    ]);
    const row = await expectConsistent(registration.id, [sponsorship.id, other.id]);
    expectNetBreakdown(row, 300);
    expect(row).toMatchObject({ paymentStatus: "PARTIAL", paidAmount: 0, paidAt: null, paymentMethod: "LAB_SPONSORSHIP" });

    // The file owns its disposable DB. Filter its persisted email outbox rows
    // by the registration aggregate, without draining/sending any message.
    const emails = (await getDb().select().from(outboxEvents)).filter((entry) =>
      entry.type === "email.sponsorship" && entry.aggregateId === registration.id,
    );
    expect(emails).toHaveLength(2);
    for (const [sponsor, counterpart, response, actor] of [
      [sponsorship, other, first.value, "race-link-first"],
      [other, sponsorship, second.value, "race-link-second"],
    ] as const) {
      const newAmount = response.registration.sponsorshipAmount;
      const oldAmount = newAmount - sponsor.totalAmount;
      expect(response.registration).toEqual({ totalAmount: 500, sponsorshipAmount: newAmount, amountDue: 500 - newAmount });
      expect(response.warnings).toEqual(oldAmount === 0 ? [] : [expect.stringContaining(counterpart.code)]);
      const usages = await sponsorshipUsagesOf(sponsor.id);
      expect(usages).toHaveLength(1);
      expect(usages[0]).toMatchObject({
        id: response.usage.id,
        sponsorshipId: sponsor.id,
        registrationId: registration.id,
        amountApplied: sponsor.totalAmount,
        appliedBy: actor,
      });
      expect(response.usage).toEqual({ id: usages[0].id, sponsorshipId: sponsor.id, amountApplied: sponsor.totalAmount });
      expect((await readSponsorshipRow(sponsor.id)).status).toBe("USED");
      const audits = await auditRowsOf("Sponsorship", sponsor.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: "LINK_TO_REGISTRATION",
        performedBy: actor,
        changes: {
          registrationId: { old: null, new: registration.id },
          amountApplied: { old: 0, new: sponsor.totalAmount },
          sponsorshipAmount: { old: oldAmount, new: newAmount },
          status: { old: "PENDING", new: "USED" },
        },
      });
      expect(await realtimeRowsOf("sponsorship.linked", sponsor.id)).toHaveLength(1);
      expect(emails).toContainEqual(expect.objectContaining({
        aggregateType: "Registration",
        eventId: registration.eventId,
        dedupeKey: `email:sponsorship:SPONSORSHIP_APPLIED:${registration.id}:${sponsor.id}`,
        maxAttempts: 5,
        payload: expect.objectContaining({
          trigger: "SPONSORSHIP_APPLIED",
          eventId: registration.eventId,
          input: expect.objectContaining({
            recipientEmail: registration.email,
            recipientName: registration.firstName,
            registrationId: registration.id,
            context: expect.objectContaining({ registrationId: registration.id, sponsorshipCode: sponsor.code }),
          }),
        }),
      }));
    }
  });

  it("two unlinks serialize and remove both usages, money and LAB method without losing an audit", async () => {
    const { registration, sponsorship } = await scenario();
    const other = await anotherSponsorship(registration, sponsorship);
    for (const sponsor of [sponsorship, other]) {
      await sponsorshipsService.linkSponsorshipToRegistration(sponsor.id, registration.id, "setup-link");
    }
    expectNetBreakdown(await expectConsistent(registration.id, [sponsorship.id, other.id]), 300);

    const results = await queueBehindLock(
      registration.id,
      () => sponsorshipsService.unlinkSponsorshipFromRegistration(sponsorship.id, registration.id, "race-unlink"),
      () => sponsorshipsService.unlinkSponsorshipFromRegistration(other.id, registration.id, "race-unlink"),
    );

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const row = await expectConsistent(registration.id, [sponsorship.id, other.id]);
    expectNetBreakdown(row, 0);
    expect(row).toMatchObject({ paymentStatus: "PENDING", paidAmount: 0, paidAt: null, paymentMethod: null });
    for (const sponsor of [sponsorship, other]) {
      expect(await sponsorshipUsagesOf(sponsor.id)).toEqual([]);
      const unlinks = (await auditRowsOf("Sponsorship", sponsor.id)).filter((entry) => entry.action === "UNLINK_FROM_REGISTRATION");
      expect(unlinks).toHaveLength(1);
      expect(unlinks[0]).toMatchObject({
        performedBy: "race-unlink",
        changes: {
          registrationId: { old: registration.id, new: null },
          amountApplied: { old: sponsor.totalAmount, new: 0 },
          status: { old: "USED", new: "PENDING" },
        },
      });
      expect(await realtimeRowsOf("sponsorship.unlinked", sponsor.id)).toHaveLength(1);
    }
  });

  it("coverage recalculation rereads a newly PAID registration and rolls back with 409", async () => {
    const { registration, sponsorship } = await scenario();
    await sponsorshipsService.linkSponsorshipToRegistration(sponsorship.id, registration.id, "setup-link");
    await withTxn((tx) => upsertEventPricing(
      tx,
      { eventId: registration.eventId, basePrice: 300, currency: "TND" },
      { basePrice: 300 },
    ));
    const originalSponsor = await readSponsorshipRow(sponsorship.id);
    const originalUsages = await sponsorshipUsagesOf(sponsorship.id);
    const originalAudits = await auditRowsOf("Sponsorship", sponsorship.id);

    // Pause confirmation after real settlement, while its transaction still
    // holds the registration lock. Observe recalculation requesting that same
    // lock before allowing confirmation to commit; elapsed time chooses no winner.
    let releaseConfirmation!: () => void;
    const released = new Promise<void>((resolve) => (releaseConfirmation = resolve));
    let paymentSettled!: () => void;
    const atPaymentBarrier = new Promise<void>((resolve) => (paymentSettled = resolve));
    let lockRequested!: () => void;
    const atRecalcLock = new Promise<void>((resolve) => (lockRequested = resolve));
    const paymentAccess = new AccessService();
    const handleCapacityReached = paymentAccess.handleCapacityReached.bind(paymentAccess);
    const capacityProbe = vi.spyOn(paymentAccess, "handleCapacityReached").mockImplementation(async (...args) => {
      const result = await handleCapacityReached(...args);
      paymentSettled();
      await released;
      return result;
    });
    const lockRegistrations = rowLocks.lockRegistrationsForUpdate;
    const lockProbe = vi.spyOn(rowLocks, "lockRegistrationsForUpdate").mockImplementation((tx, ids) => {
      const pendingLock = lockRegistrations(tx, ids);
      if (ids.includes(registration.id)) lockRequested();
      return pendingLock;
    });
    const paymentService = new RegistrationPaymentsService(paymentAccess, new RegistrationSideEffects(paymentAccess));
    const confirmation = Promise.allSettled([
      paymentService.confirmPayment(registration.id, { paymentStatus: "PAID" }, "admin-1"),
    ]);
    let recalculation: ReturnType<typeof sponsorshipsService.updateSponsorship> | undefined;
    let outcomes: PromiseSettledResult<unknown>[];
    try {
      await Promise.race([
        atPaymentBarrier,
        confirmation.then(() => { throw new Error("Confirmation ended before the settlement barrier"); }),
      ]);
      recalculation = sponsorshipsService.updateSponsorship(sponsorship.id, { coversBasePrice: true }, "race-recalc");
      const recalculationResult = Promise.allSettled([recalculation]);
      await Promise.race([
        atRecalcLock,
        recalculationResult.then(() => { throw new Error("Recalculation ended without requesting the registration lock"); }),
      ]);
      expect(await settlesWithin(recalculation, 50)).toBe(false);
      releaseConfirmation();
      outcomes = [...await confirmation, ...await recalculationResult];
    } finally {
      releaseConfirmation();
      await confirmation;
      await recalculation?.catch(() => undefined);
      lockProbe.mockRestore();
      capacityProbe.mockRestore();
    }
    const [confirmed, recalculated] = outcomes;

    expect(confirmed.status).toBe("fulfilled");
    expect(recalculated.status).toBe("rejected");
    if (recalculated.status !== "rejected") throw new Error("Expected a settled-target refusal");
    expect(recalculated.reason).toMatchObject({ code: ErrorCodes.SPONSORSHIP_TARGET_SETTLED, statusCode: 409 });
    const row = await expectConsistent(registration.id, [sponsorship.id]);
    expectNetBreakdown(row, 200);
    expect(row).toMatchObject({ paymentStatus: "PAID", paidAmount: 300, paymentMethod: "LAB_SPONSORSHIP" });
    expect(row.paidAt).toBeInstanceOf(Date);
    expect(await readSponsorshipRow(sponsorship.id)).toEqual(originalSponsor);
    expect(await sponsorshipUsagesOf(sponsorship.id)).toEqual(originalUsages);
    expect(await auditRowsOf("Sponsorship", sponsorship.id)).toEqual(originalAudits);
    expect(await realtimeRowsOf("sponsorship.updated", sponsorship.id)).toEqual([]);
    const confirmations = (await auditRowsOf("Registration", registration.id)).filter((entry) => entry.action === "PAYMENT_CONFIRMED");
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toMatchObject({
      performedBy: "admin-1",
      changes: { paidAmount: { old: 0, new: 300 } },
    });
  });

  it.each(["cancel", "delete"] as const)("%s settles overlapping registration sets inserted in opposite order", async (operation) => {
    const { registration, sponsorship } = await scenario();
    const second = await seedRegistration({
      eventId: registration.eventId,
      formId: registration.formId,
      totalAmount: 500,
      baseAmount: 500,
      paymentStatus: "PENDING",
      priceBreakdown: breakdown(500),
    });
    const other = await anotherSponsorship(registration, sponsorship);
    // Opposite usage insertion order must not produce an incompatible lock order.
    for (const target of [registration, second]) {
      await sponsorshipsService.linkSponsorshipToRegistration(sponsorship.id, target.id, "setup-link");
    }
    for (const target of [second, registration]) {
      await sponsorshipsService.linkSponsorshipToRegistration(other.id, target.id, "setup-link");
    }
    for (const target of [registration, second]) {
      expectNetBreakdown(await expectConsistent(target.id, [sponsorship.id, other.id]), 300);
    }
    const releaseSponsor = async (id: string): Promise<void> => {
      if (operation === "cancel") {
        await sponsorshipsService.cancelSponsorship(id, `race-${operation}`);
      } else {
        await sponsorshipsService.deleteSponsorship(id, `race-${operation}`);
      }
    };
    const firstRegistrationId = [registration.id, second.id].sort()[0];

    const results = await queueBehindLock(
      firstRegistrationId,
      () => releaseSponsor(sponsorship.id),
      () => releaseSponsor(other.id),
    );

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    for (const target of [registration, second]) {
      const row = await readRegistration(target.id);
      expectNetBreakdown(row, 0);
      expect(row).toMatchObject({ paymentStatus: "PENDING", paidAmount: 0, paidAt: null, paymentMethod: null });
    }
    for (const sponsor of [sponsorship, other]) {
      expect(await sponsorshipUsagesOf(sponsor.id)).toEqual([]);
      const stored = await readSponsorshipRow(sponsor.id);
      if (operation === "cancel") expect(stored).toMatchObject({ status: "CANCELLED" });
      else expect(stored).toBeUndefined();
      const audits = await auditRowsOf("Sponsorship", sponsor.id);
      const unlinks = audits.filter((entry) => entry.action === "UNLINK_FROM_REGISTRATION");
      expect(unlinks).toHaveLength(2);
      for (const target of [registration, second]) {
        expect(unlinks).toContainEqual(expect.objectContaining({
          performedBy: `race-${operation}`,
          changes: expect.objectContaining({
            registrationId: { old: target.id, new: null },
            amountApplied: { old: sponsor.totalAmount, new: 0 },
          }),
        }));
      }
      const terminal = audits.filter((entry) => entry.action === (operation === "cancel" ? "CANCEL" : "DELETE"));
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({ performedBy: `race-${operation}` });
      expect(await realtimeRowsOf(operation === "cancel" ? "sponsorship.cancelled" : "sponsorship.deleted", sponsor.id)).toHaveLength(1);
    }
  });
});
