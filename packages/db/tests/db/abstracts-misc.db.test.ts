import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  abstractBookJobs,
  abstractBookQueue,
  completeAbstractBookJob,
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

  // 3.4: a RUNNING job whose worker died used to block the event until the
  // hour-long lease ran out and the worker's recovery ran; enqueue now
  // recovers it itself.
  describe("enqueue with an existing RUNNING job", () => {
    async function runningJob(options: { attemptsLeft?: number } = {}) {
      const event = await seedEvent({ status: "OPEN" });
      await seedAbstractConfig({ eventId: event.id });
      const first = await enqueueAbstractBookJob({ eventId: event.id, requestedBy: "admin-1" });
      if (!first.ok) throw new Error("enqueue failed");
      if (options.attemptsLeft !== undefined) {
        await getDb()
          .update(abstractBookJobs)
          .set({ attemptCount: first.job.maxAttempts - options.attemptsLeft })
          .where(eq(abstractBookJobs.id, first.job.id));
      }
      // CockroachDB's SKIP LOCKED can transiently miss a just-written row.
      await vi.waitFor(async () => {
        expect(await abstractBookQueue.claim("dead-worker", 1)).toEqual([first.job.id]);
      }, { timeout: 5_000, interval: 25 });
      return { eventId: event.id, jobId: first.job.id };
    }

    async function expireLease(jobId: string) {
      await getDb().execute(sql`
        UPDATE "abstract_book_jobs"
        SET "locked_until" = (statement_timestamp() AT TIME ZONE 'UTC') - interval '1 second'
        WHERE "id" = ${jobId}
      `);
    }

    it("returns a live RUNNING job as-is", async () => {
      const { eventId, jobId } = await runningJob();
      const again = await enqueueAbstractBookJob({ eventId, requestedBy: "admin-2" });
      expect(again.ok && again.job).toMatchObject({ id: jobId, status: "RUNNING", lockedBy: "dead-worker" });
    });

    it("requeues an expired RUNNING job (attempt kept) and returns it", async () => {
      const { eventId, jobId } = await runningJob();
      await expireLease(jobId);

      const again = await enqueueAbstractBookJob({ eventId, requestedBy: "admin-2" });
      expect(again.ok && again.job).toMatchObject({ id: jobId, status: "PENDING", lockedBy: null, attemptCount: 1 });
      // The dead worker's late write misses.
      expect(
        await completeAbstractBookJob({ jobId, workerId: "dead-worker", storageKey: "k", includedCount: 0 }),
      ).toBe(false);
      expect(await getDb().select().from(abstractBookJobs)).toHaveLength(1);
    });

    it("dead-letters an expired job without attempts left, then enqueues a new one", async () => {
      const { eventId, jobId } = await runningJob({ attemptsLeft: 1 });
      await expireLease(jobId);

      const again = await enqueueAbstractBookJob({ eventId, requestedBy: "admin-2" });
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.job.id).not.toBe(jobId);
      expect(again.job.status).toBe("PENDING");
      const [old] = await getDb().select().from(abstractBookJobs).where(eq(abstractBookJobs.id, jobId));
      expect(old).toMatchObject({ status: "FAILED", lockedBy: null });
      expect(old!.errorMessage).toContain("retry limit was exhausted");
    });
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

  // L6 coverage: the ILIKE fragment spans five fields — exercise each one so a
  // regression in any single predicate (not just lastName) fails a test.
  it("L6: search matches case-insensitively across all five searchable fields", async () => {
    const event = await seedEvent({ status: "OPEN" });
    const abstract = await seedAbstract({
      eventId: event.id,
      authorFirstName: "Amira",
      authorLastName: "Bouazizi",
      authorAffiliation: "Hôpital Charles Nicolle",
      authorEmail: "Amira.Bouazizi@Example.test",
      code: "OC0-07",
    });

    for (const q of ["amira", "bouazizi", "charles nicolle", "AMIRA.BOUAZIZI@", "oc0-07"]) {
      const { items, total } = await listAdminAbstracts(event.id, {
        q,
        limit: 10,
        offset: 0,
      });
      expect(total, `query "${q}"`).toBe(1);
      expect(items[0].id, `query "${q}"`).toBe(abstract.id);
    }
  });
});
