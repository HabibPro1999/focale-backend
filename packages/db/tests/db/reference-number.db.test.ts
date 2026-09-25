import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  allocateReferenceNumber,
  getDb,
  lockEventForUpdate,
  lockRegistrationForUpdate,
  registrationReferenceCounters,
  registrations,
  withTxn,
  type DbExecutor,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent, seedForm, seedRegistration } from "../helpers/factories";

// Plan 2.3: reference numbers come from one counter row per prefix
// ("YY-SLUGCODE-", migration 0021) instead of an event lock plus a
// LIKE … FOR UPDATE scan of registrations.

const START = new Date("2027-12-31T23:30:00.000Z"); // 2027 in UTC, 2028 east of UTC

function suffix(referenceNumber: string, prefix: string): number {
  expect(referenceNumber.startsWith(prefix)).toBe(true);
  return Number(referenceNumber.slice(prefix.length));
}

const range = (n: number) => Array.from({ length: n }, (_, index) => index + 1);

async function seedEventWithForm(slug: string) {
  const event = await seedEvent({ slug, startDate: START, endDate: new Date("2028-01-02T17:00:00.000Z") });
  const form = await seedForm({ eventId: event.id });
  return { event, form };
}

/** A registration create reduced to its numbering: allocate, then insert, in one transaction. */
function createRegistration(eventId: string, formId: string): Promise<string> {
  return withTxn(async (tx) => {
    const referenceNumber = await allocateReferenceNumber(eventId, tx);
    await tx.insert(registrations).values({
      formId,
      eventId,
      formData: {},
      email: `registrant-${randomUUID()}@example.test`,
      totalAmount: 0,
      priceBreakdown: {},
      referenceNumber,
    });
    return referenceNumber;
  });
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true, () => true), sleep(ms).then(() => false)]);
}

describe.runIf(dbTestsEnabled())("db tier: registration reference-number counter", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it("gives 20 parallel allocations exactly 1..20", async () => {
    const { event } = await seedEventWithForm("parallel-numbers");
    const numbers = await Promise.all(
      range(20).map(() => withTxn((tx) => allocateReferenceNumber(event.id, tx))),
    );
    expect(numbers.map((n) => suffix(n, "27-PARALLEL-NUM-")).sort((a, b) => a - b)).toEqual(range(20));
    const [counter] = await getDb()
      .select()
      .from(registrationReferenceCounters)
      .where(eq(registrationReferenceCounters.prefix, "27-PARALLEL-NUM-"));
    expect(counter?.lastValue).toBe(20);
  });

  it("numbers parallel creates in two events sharing a prefix from one sequence, with no duplicate", async () => {
    const paris = await seedEventWithForm("congress-2027-paris");
    const lyon = await seedEventWithForm("congress-2027-lyon");
    // Promise.all rejects on any unique violation (23505) of registrations_reference_number_key.
    const numbers = await Promise.all(
      range(20).map((index) => {
        const { event, form } = index % 2 === 0 ? paris : lyon;
        return createRegistration(event.id, form.id);
      }),
    );
    expect(new Set(numbers).size).toBe(20);
    expect(numbers.map((n) => suffix(n, "27-CONGRESS-202-")).sort((a, b) => a - b)).toEqual(range(20));
  });

  it("seeds a new prefix from the largest numeric suffix already stored", async () => {
    const { event, form } = await seedEventWithForm("seeded");
    const other = await seedEventWithForm("seeded-x");
    // Zero-padded suffixes are decimal: CockroachDB's INT cast would read '012' as octal 10 and reject '009'.
    for (const referenceNumber of ["27-SEEDED-007", "27-SEEDED-009", "27-SEEDED-012", "27-SEEDED-ABC"]) {
      await seedRegistration({ eventId: event.id, formId: form.id, referenceNumber });
    }
    // Another event's prefix that merely starts with ours is not counted.
    await seedRegistration({ eventId: other.event.id, formId: other.form.id, referenceNumber: "27-SEEDED-X-099" });
    expect(await createRegistration(event.id, form.id)).toBe("27-SEEDED-013");
    expect(await createRegistration(event.id, form.id)).toBe("27-SEEDED-014");
  });

  it("moves past a number that was stored outside the counter", async () => {
    const { event, form } = await seedEventWithForm("outside");
    expect(await createRegistration(event.id, form.id)).toBe("27-OUTSIDE-001");
    // The legacy app (during rollout) or a manual insert used the next number.
    await seedRegistration({ eventId: event.id, formId: form.id, referenceNumber: "27-OUTSIDE-002" });
    await seedRegistration({ eventId: event.id, formId: form.id, referenceNumber: "27-OUTSIDE-003" });
    expect(await createRegistration(event.id, form.id)).toBe("27-OUTSIDE-004");
    expect(await createRegistration(event.id, form.id)).toBe("27-OUTSIDE-005");
  });

  it("leaves no gap when the allocating transaction rolls back", async () => {
    const { event, form } = await seedEventWithForm("rollback");
    expect(await createRegistration(event.id, form.id)).toBe("27-ROLLBACK-001");
    await expect(withTxn(async (tx) => {
      expect(await allocateReferenceNumber(event.id, tx)).toBe("27-ROLLBACK-002");
      throw new Error("create failed after numbering");
    })).rejects.toThrow("create failed after numbering");
    expect(await createRegistration(event.id, form.id)).toBe("27-ROLLBACK-002");
  });

  it("takes neither the event lock nor locks on the prefix's registrations", async () => {
    const { event, form } = await seedEventWithForm("unlocked");
    const existing = await seedRegistration({ eventId: event.id, formId: form.id, referenceNumber: "27-UNLOCKED-001" });
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let holding!: () => void;
    const held = new Promise<void>((resolve) => (holding = resolve));
    const holder = withTxn(async (tx: DbExecutor) => {
      await lockEventForUpdate(tx, event.id);
      await lockRegistrationForUpdate(tx, existing.id);
      holding();
      await released;
    });
    await held;
    try {
      const allocation = withTxn((tx) => allocateReferenceNumber(event.id, tx));
      expect(await settlesWithin(allocation, 5_000)).toBe(true);
      expect(await allocation).toBe("27-UNLOCKED-002");
    } finally {
      release();
      await holder;
    }
  });
});
