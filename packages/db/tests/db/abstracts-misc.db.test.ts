import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  abstractBookJobs,
  enqueueAbstractBookJob,
  getDb,
  listAdminAbstracts,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedAbstract, seedAbstractConfig, seedEvent } from "../helpers/factories";

describe.runIf(dbTestsEnabled())("db tier: book jobs + admin search", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  // L1: enqueueAbstractBookJob had no guard against an already PENDING/RUNNING
  // job for the event, so a double-click (or two admin tabs) could enqueue two
  // concurrent book jobs. The fix returns the existing job idempotently instead
  // — sequentially (in-txn check) and under a genuine race (partial unique
  // index + 23505 catch).
  it("L1: a second enqueue while one is PENDING returns the same job, not a duplicate", async () => {
    const event = await seedEvent({ status: "OPEN" });
    await seedAbstractConfig({ eventId: event.id });

    const first = await enqueueAbstractBookJob({
      eventId: event.id,
      requestedBy: "admin-1",
    });
    const second = await enqueueAbstractBookJob({
      eventId: event.id,
      requestedBy: "admin-2",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.job.id).toBe(first.job.id);
    }

    const rows = await getDb().select().from(abstractBookJobs);
    expect(rows).toHaveLength(1);
  });

  it("L1: concurrent enqueues race-safely collapse to a single job", async () => {
    const event = await seedEvent({ status: "OPEN" });
    await seedAbstractConfig({ eventId: event.id });

    const [a, b] = await Promise.all([
      enqueueAbstractBookJob({ eventId: event.id, requestedBy: "admin-1" }),
      enqueueAbstractBookJob({ eventId: event.id, requestedBy: "admin-2" }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const rows = await getDb().select().from(abstractBookJobs);
    expect(rows).toHaveLength(1);
  });

  // L6: admin search used case-sensitive LIKE, so searching "dupont" never
  // matched an author stored as "Dupont".
  it("L6: admin abstract search is case-insensitive", async () => {
    const event = await seedEvent({ status: "OPEN" });
    await seedAbstract({
      eventId: event.id,
      authorFirstName: "Jean",
      authorLastName: "Dupont",
    });

    const { items, total } = await listAdminAbstracts(event.id, {
      q: "dupont",
      limit: 10,
      offset: 0,
    });

    expect(total).toBe(1);
    expect(items).toHaveLength(1);
    expect(items[0].authorLastName).toBe("Dupont");
  });
});
