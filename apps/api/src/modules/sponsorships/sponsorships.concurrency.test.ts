import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Observe arrival at the real registration lock/write without replacing any SQL.
// A held registration lock makes the old implementation finish its stale reads
// before either write, while the fixed implementation waits before those reads.
const arrivals = vi.hoisted(() => ({ observe: undefined as ((id: string) => void) | undefined }));
vi.mock("@app/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@app/db")>();
  return {
    ...actual,
    lockRegistrationForUpdate: (tx: Parameters<typeof actual.lockRegistrationForUpdate>[0], id: string) => {
      arrivals.observe?.(id);
      return actual.lockRegistrationForUpdate(tx, id);
    },
    lockRegistrationsForUpdate: (tx: Parameters<typeof actual.lockRegistrationsForUpdate>[0], ids: readonly string[]) => {
      for (const id of new Set(ids)) arrivals.observe?.(id);
      return actual.lockRegistrationsForUpdate(tx, ids);
    },
    // PostgreSQL's usage FK also waits on the held parent row. Observe it so
    // the old link path reaches the gate after its stale registration read.
    insertUsage: (...args: Parameters<typeof actual.insertUsage>) => {
      if (args[1].registrationId) arrivals.observe?.(args[1].registrationId);
      return actual.insertUsage(...args);
    },
    updateRegistrationSettlement: (...args: Parameters<typeof actual.updateRegistrationSettlement>) => {
      arrivals.observe?.(args[1]);
      return actual.updateRegistrationSettlement(...args);
    },
  };
});

import {
  eventPricing,
  findRegistrationSettlementState,
  findUsageAmountsByRegistration,
  getDb,
  lockRegistrationForUpdate,
  updateRegistrationSettlement,
  withTxn,
} from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { cleanupDatabase } from "@app/db/testing/fixtures";
import {
  seedClient,
  seedEvent,
  seedForm,
  seedRegistration,
  seedSponsorship,
  seedSponsorshipBatch,
  seedSponsorshipUsage,
} from "@app/db/testing/fixtures";
import { AccessService } from "../access/access.service";
import { SponsorshipsService } from "./sponsorships.service";

const service = new SponsorshipsService(new AccessService());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function contend(
  registrationId: string,
  operations: Array<() => Promise<unknown>>,
  markPaid = false,
) {
  const locked = deferred();
  const release = deferred();
  const waiting = deferred();
  let count = 0;
  const holder = withTxn(async (tx) => {
    await lockRegistrationForUpdate(tx, registrationId);
    locked.resolve();
    await release.promise;
    if (markPaid) await updateRegistrationSettlement(tx, registrationId, { paymentStatus: "PAID" });
  });
  await Promise.race([locked.promise, holder]);
  arrivals.observe = (id) => {
    if (id === registrationId && ++count === operations.length) waiting.resolve();
  };
  const pending = Promise.allSettled(operations.map((operation) => operation()));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      waiting.promise,
      pending.then(() => { throw new Error("Operations completed before reaching the held registration"); }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Only ${count}/${operations.length} operations reached the held registration`)), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    arrivals.observe = undefined;
    release.resolve();
    await holder;
    const results = await pending;
    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
  }
}

async function fixture(amounts = [300, 200]) {
  const client = await seedClient({ enabledModules: ["sponsorships"] });
  const event = await seedEvent({ clientId: client.id, status: "OPEN" });
  const form = await seedForm({ eventId: event.id });
  const registration = await seedRegistration({
    eventId: event.id,
    formId: form.id,
    totalAmount: 1000,
    baseAmount: 1000,
    priceBreakdown: { calculatedBasePrice: 1000, subtotal: 1000, accessItems: [] },
  });
  const batch = await seedSponsorshipBatch({ eventId: event.id, formId: form.id });
  const sponsors = await Promise.all(amounts.map((totalAmount) => seedSponsorship({
    eventId: event.id,
    batchId: batch.id,
    coversBasePrice: true,
    totalAmount,
  })));
  return { event, form, registration, sponsors };
}

async function expectAmount(registrationId: string, expected: number) {
  const usages = await findUsageAmountsByRegistration(getDb(), registrationId);
  expect(usages.reduce((sum, usage) => sum + usage.amountApplied, 0)).toBe(expected);
  expect((await findRegistrationSettlementState(getDb(), registrationId))?.sponsorshipAmount).toBe(expected);
}

describe.runIf(dbTestsEnabled())("sponsorship service settlement under concurrency", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it("serializes two links and re-reads a payment status committed while waiting", async () => {
    const { registration, sponsors } = await fixture();
    await contend(registration.id, sponsors.map((sponsor) => () =>
      service.linkSponsorshipToRegistration(sponsor.id, registration.id, "concurrency-test")), true);
    expect((await findRegistrationSettlementState(getDb(), registration.id))?.paymentStatus).toBe("PAID");
    await expectAmount(registration.id, 500);
  });

  it("serializes two unlinks without leaving either removed usage in settlement", async () => {
    const { registration, sponsors } = await fixture();
    for (const sponsor of sponsors) await service.linkSponsorshipToRegistration(sponsor.id, registration.id, "concurrency-test");
    await contend(registration.id, sponsors.map((sponsor) => () =>
      service.unlinkSponsorshipFromRegistration(sponsor.id, registration.id)), true);
    await expectAmount(registration.id, 0);
    expect((await findRegistrationSettlementState(getDb(), registration.id))?.paymentStatus).toBe("PAID");
  });

  it("serializes coverage recalculations and discards registration state read before the lock", async () => {
    const { event, registration, sponsors } = await fixture([100, 100]);
    await getDb().insert(eventPricing).values({ eventId: event.id, basePrice: 400 });
    for (const sponsor of sponsors) await service.linkSponsorshipToRegistration(sponsor.id, registration.id, "concurrency-test");
    await contend(registration.id, sponsors.map((sponsor) => () =>
      service.updateSponsorship(sponsor.id, { coversBasePrice: true })), true);
    await expectAmount(registration.id, 800);
    expect((await findRegistrationSettlementState(getDb(), registration.id))?.paymentStatus).toBe("PAID");
  });

  it.each(["cancel", "delete"] as const)("%s locks overlapping registration sets before unlinking in usage order", async (operation) => {
    const { event, form, registration, sponsors } = await fixture();
    const second = await seedRegistration({ eventId: event.id, formId: form.id, totalAmount: 1000 });
    // Opposite insertion order must not turn into opposite lock order.
    for (let i = 0; i < sponsors.length; i++) {
      for (const target of i === 0 ? [registration, second] : [second, registration]) {
        await seedSponsorshipUsage({ sponsorshipId: sponsors[i].id, registrationId: target.id, amountApplied: sponsors[i].totalAmount, appliedBy: "concurrency-test" });
      }
    }
    for (const target of [registration, second]) {
      await updateRegistrationSettlement(getDb(), target.id, { sponsorshipAmount: 500, paymentStatus: "PARTIAL" });
    }
    await contend(registration.id, sponsors.map((sponsor) => () => operation === "cancel"
      ? service.cancelSponsorship(sponsor.id)
      : service.deleteSponsorship(sponsor.id)));
    await expectAmount(registration.id, 0);
    await expectAmount(second.id, 0);
  });
});
