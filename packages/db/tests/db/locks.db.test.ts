import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  getDb,
  lockAbstractForUpdate,
  lockAbstractsForUpdate,
  lockEventAccessRowsForUpdate,
  lockEventForUpdate,
  lockRegistrationForUpdate,
  lockRegistrationsForUpdate,
  lockSponsorshipByCodeForUpdate,
  lockSponsorshipForUpdate,
  lockSponsorshipsForUpdate,
  registrations,
  withLockingTxn,
  withTxn,
  type DbExecutor,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import { makeBarrier } from "../helpers/barrier";
import {
  seedAbstract,
  seedEvent,
  seedEventAccess,
  seedForm,
  seedRegistration,
  seedSponsorship,
  seedSponsorshipBatch,
} from "../helpers/factories";

// Row lock helpers (plan 2.2, ADR 0001): each lock blocks a second locker of
// the same row until the first transaction ends, locks nothing else, and
// multi-row locks take rows in ascending id order so opposite request orders
// queue instead of deadlocking.

async function seedFixture() {
  const event = await seedEvent({ status: "OPEN" });
  const form = await seedForm({ eventId: event.id });
  const first = await seedRegistration({ formId: form.id, eventId: event.id });
  const second = await seedRegistration({ formId: form.id, eventId: event.id });
  const batch = await seedSponsorshipBatch({ eventId: event.id, formId: form.id });
  const sponsorship = await seedSponsorship({ batchId: batch.id, eventId: event.id });
  const otherSponsorship = await seedSponsorship({ batchId: batch.id, eventId: event.id });
  const abstract = await seedAbstract({ eventId: event.id });
  const otherAbstract = await seedAbstract({ eventId: event.id });
  const access = await seedEventAccess({ eventId: event.id });
  const otherAccess = await seedEventAccess({ eventId: event.id });
  return { event, first, second, sponsorship, otherSponsorship, abstract, otherAbstract, access, otherAccess };
}
type Fixture = Awaited<ReturnType<typeof seedFixture>>;

const LOCKS: Array<{ name: string; lock: (tx: DbExecutor, f: Fixture) => Promise<unknown> }> = [
  { name: "lockRegistrationForUpdate", lock: (tx, f) => lockRegistrationForUpdate(tx, f.first.id) },
  { name: "lockRegistrationsForUpdate", lock: (tx, f) => lockRegistrationsForUpdate(tx, [f.second.id, f.first.id]) },
  { name: "lockSponsorshipForUpdate", lock: (tx, f) => lockSponsorshipForUpdate(tx, f.sponsorship.id) },
  {
    name: "lockSponsorshipsForUpdate",
    lock: (tx, f) => lockSponsorshipsForUpdate(tx, [f.otherSponsorship.id, f.sponsorship.id]),
  },
  {
    name: "lockSponsorshipByCodeForUpdate",
    lock: (tx, f) => lockSponsorshipByCodeForUpdate(tx, f.event.id, f.sponsorship.code),
  },
  { name: "lockAbstractForUpdate", lock: (tx, f) => lockAbstractForUpdate(tx, f.abstract.id) },
  { name: "lockAbstractsForUpdate", lock: (tx, f) => lockAbstractsForUpdate(tx, [f.otherAbstract.id, f.abstract.id]) },
  { name: "lockEventForUpdate", lock: (tx, f) => lockEventForUpdate(tx, f.event.id) },
  {
    name: "lockEventAccessRowsForUpdate",
    lock: (tx, f) => lockEventAccessRowsForUpdate(tx, [f.otherAccess.id, f.access.id]),
  },
];

/** Start a transaction that takes `lock` and holds it until `release()`. */
async function holdLock(lock: (tx: DbExecutor) => Promise<unknown>) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const done = withTxn(async (tx) => {
    await lock(tx);
    locked();
    await released;
  });
  await Promise.race([isLocked, done]);
  return { release, done };
}

/** True when `promise` settles within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const settled = await Promise.race([
    promise.then(() => true, () => true),
    sleep(ms).then(() => false),
  ]);
  return settled;
}

describe.runIf(dbTestsEnabled())("db tier: row lock helpers", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it.each(LOCKS)("$name makes a second locker wait until the first commits", async ({ lock }) => {
    const f = await seedFixture();
    const holder = await holdLock((tx) => lock(tx, f));
    try {
      const second = withTxn((tx) => lock(tx, f));
      expect(await settlesWithin(second, 500)).toBe(false);
      holder.release();
      await holder.done;
      await second;
    } finally {
      holder.release();
      await holder.done.catch(() => undefined);
    }
  });

  it("returns what each lock found", async () => {
    const f = await seedFixture();
    const otherEvent = await seedEvent();
    await withTxn(async (tx) => {
      expect(await lockRegistrationForUpdate(tx, f.first.id)).toBe(true);
      expect(await lockRegistrationForUpdate(tx, "missing")).toBe(false);
      const ascending = [f.first.id, f.second.id].sort();
      expect(await lockRegistrationsForUpdate(tx, [ascending[1]!, "missing", ascending[0]!, ascending[1]!]))
        .toEqual(ascending);
      expect(await lockRegistrationsForUpdate(tx, [])).toEqual([]);
      expect(await lockSponsorshipByCodeForUpdate(tx, f.event.id, f.sponsorship.code)).toBe(f.sponsorship.id);
      // Codes are matched exactly and only within the event.
      expect(await lockSponsorshipByCodeForUpdate(tx, f.event.id, f.sponsorship.code.toLowerCase())).toBeNull();
      expect(await lockSponsorshipByCodeForUpdate(tx, otherEvent.id, f.sponsorship.code)).toBeNull();
      expect(await lockEventForUpdate(tx, f.event.id)).toBe(true);
      expect(await lockAbstractsForUpdate(tx, [f.abstract.id])).toEqual([f.abstract.id]);
      expect(await lockEventAccessRowsForUpdate(tx, [f.otherAccess.id, "missing", f.access.id]))
        .toEqual([f.access.id, f.otherAccess.id].sort());
    });
  });

  it("locks only the named rows, not the event or other registrations", async () => {
    const f = await seedFixture();
    const holder = await holdLock((tx) => lockRegistrationForUpdate(tx, f.first.id));
    try {
      const others = withTxn(async (tx) => {
        await lockEventForUpdate(tx, f.event.id);
        await lockRegistrationForUpdate(tx, f.second.id);
        await lockSponsorshipByCodeForUpdate(tx, f.event.id, f.sponsorship.code);
      });
      expect(await settlesWithin(others, 5_000)).toBe(true);
      await others;
    } finally {
      holder.release();
      await holder.done;
    }
  });

  it("re-reads the first transaction's committed write after taking the lock", async () => {
    const f = await seedFixture();
    const holder = await holdLock(async (tx) => {
      await lockRegistrationForUpdate(tx, f.first.id);
      await tx.update(registrations).set({ paidAmount: 700 }).where(eq(registrations.id, f.first.id));
    });
    const second = withTxn(async (tx) => {
      await lockRegistrationForUpdate(tx, f.first.id);
      const [row] = await tx
        .select({ paidAmount: registrations.paidAmount })
        .from(registrations)
        .where(eq(registrations.id, f.first.id));
      return row!.paidAmount;
    });
    expect(await settlesWithin(second, 500)).toBe(false);
    holder.release();
    await holder.done;
    expect(await second).toBe(700);
  });

  it("queues instead of deadlocking when two transactions lock [b, a] and [a, b]", async () => {
    const f = await seedFixture();
    const ascending = [f.first.id, f.second.id].sort();
    for (let round = 0; round < 3; round += 1) {
      const barrier = makeBarrier(2);
      const events: string[] = [];
      // No retry: a deadlock would reject one of these transactions.
      const run = (name: string, ids: string[]) =>
        withTxn(async (tx) => {
          await barrier();
          expect(await lockRegistrationsForUpdate(tx, ids)).toEqual(ascending);
          events.push(`${name}:locked`);
          await sleep(100);
          events.push(`${name}:done`);
        });
      await Promise.all([run("x", [f.second.id, f.first.id]), run("y", [f.first.id, f.second.id])]);
      // Whoever locked first held both rows until it committed.
      const winner = events[0]!.split(":")[0];
      expect(events[1]).toBe(`${winner}:done`);
    }
  });

  it("withLockingTxn runs a deadlocked transaction again (row-by-row locks in opposite orders)", async () => {
    const f = await seedFixture();
    const barrier = makeBarrier(2);
    let attempts = 0;
    const run = (firstId: string, secondId: string) =>
      withLockingTxn(async (tx) => {
        attempts += 1;
        await lockRegistrationForUpdate(tx, firstId);
        await barrier();
        await lockRegistrationForUpdate(tx, secondId);
      });
    await Promise.all([run(f.first.id, f.second.id), run(f.second.id, f.first.id)]);
    // Each transaction held one row and waited for the other's: one was aborted and ran again.
    expect(attempts).toBeGreaterThanOrEqual(3);
  });

  it("refuses to lock outside a transaction", async () => {
    const f = await seedFixture();
    await expect(lockRegistrationForUpdate(getDb(), f.first.id)).rejects.toThrow(/inside a transaction/);
    await expect(lockSponsorshipByCodeForUpdate(getDb(), f.event.id, f.sponsorship.code))
      .rejects.toThrow(/inside a transaction/);
  });
});
