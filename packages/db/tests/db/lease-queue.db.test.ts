import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { JobTimeoutError } from "@app/shared";
import {
  DB_NOW,
  getDb,
  outboxEvents,
  outboxQueue,
  runLeased,
  type LeaseQueue,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";

// 3.4: one contract for every lease queue, run against each queue's spec on a
// migrated database (both engines in CI). A queue joins by adding a fixture.

interface QueueFixture {
  name: string;
  queue: LeaseQueue;
  table: string;
  /** Insert `n` due rows; returns their ids oldest (first claimed) first. */
  seed(n: number, options?: { attemptsLeft?: number }): Promise<string[]>;
  /** Insert a row that is not due yet. */
  seedNotDue(): Promise<string>;
  /** Terminal writes a handler would make, and the status each leaves. */
  completeSet: SQL;
  completedStatus: string;
  failSet: SQL;
  failedStatus: string;
  /** Status of a released row that had no earlier attempt. */
  releasedStatus: string;
  /** Status of an expired lease requeued by recovery, and of an exhausted one. */
  requeuedStatus: string;
  deadStatus: string;
  reset(): Promise<void>;
}

const MAX_ATTEMPTS = 5;

const outboxFixture: QueueFixture = {
  name: "outbox",
  queue: outboxQueue,
  table: "outbox_events",
  async seed(n, options = {}) {
    const base = Date.now() - 60_000;
    const rows = Array.from({ length: n }, (_, i) => ({
      type: "test.lease",
      payload: { i },
      status: "PENDING",
      maxAttempts: MAX_ATTEMPTS,
      attemptCount: options.attemptsLeft === undefined ? 0 : MAX_ATTEMPTS - options.attemptsLeft,
      createdAt: new Date(base + i * 10),
    }));
    const inserted = await getDb().insert(outboxEvents).values(rows).returning({ id: outboxEvents.id, createdAt: outboxEvents.createdAt });
    return inserted.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((row) => row.id);
  },
  async seedNotDue() {
    const [row] = await getDb()
      .insert(outboxEvents)
      .values({ type: "test.lease", payload: {}, status: "FAILED", attemptCount: 1, nextAttemptAt: new Date(Date.now() + 3_600_000) })
      .returning({ id: outboxEvents.id });
    return row!.id;
  },
  completeSet: sql`"status" = 'PROCESSED', "processed_at" = ${DB_NOW}`,
  completedStatus: "PROCESSED",
  failSet: sql`"status" = 'FAILED', "error_message" = 'boom', "next_attempt_at" = ${DB_NOW} + interval '1 minute'`,
  failedStatus: "FAILED",
  releasedStatus: "PENDING",
  requeuedStatus: "FAILED",
  deadStatus: "DEAD_LETTERED",
  async reset() {
    await getDb().delete(outboxEvents);
  },
};

const FIXTURES: QueueFixture[] = [outboxFixture];

interface LeaseRow {
  status: string;
  attempts: number;
  owner: string | null;
  /** ms until the lease ends (negative once expired), null without a lease. */
  leaseLeftMs: number | null;
}

async function readRow(table: string, id: string): Promise<LeaseRow> {
  const res = (await getDb().execute(sql`
    SELECT "status"::text AS status, "attempt_count" AS attempts, "locked_by" AS owner,
           (EXTRACT(EPOCH FROM ("locked_until" - ${DB_NOW})) * 1000)::float8 AS lease_left
    FROM ${sql.identifier(table)} WHERE "id" = ${id}
  `)) as unknown as { rows: Array<{ status: string; attempts: number | string; owner: string | null; lease_left: number | string | null }> };
  const row = res.rows[0]!;
  return {
    status: row.status,
    attempts: Number(row.attempts),
    owner: row.owner,
    leaseLeftMs: row.lease_left === null ? null : Number(row.lease_left),
  };
}

/** Move the lease end to `ms` from now (negative: already expired). */
async function setLeaseLeft(table: string, ids: string[], ms: number): Promise<void> {
  const shift = sql.raw(`${ms < 0 ? "-" : "+"} interval '${Math.abs(Math.trunc(ms))} milliseconds'`);
  await getDb().execute(sql`
    UPDATE ${sql.identifier(table)}
    SET "locked_until" = ${DB_NOW} ${shift}
    WHERE "id" IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// CockroachDB's SKIP LOCKED can skip rows whose committed intents are not
// resolved yet (cockroachdb/cockroach#167582): a claim right after a write may
// transiently miss rows. Production just picks them up next tick; the tests
// claim again until they hold the rows they expect.
async function claimExactly(queue: LeaseQueue, workerId: string, count: number, leaseMs?: number): Promise<string[]> {
  const got: string[] = [];
  await vi.waitFor(
    async () => {
      if (got.length < count) got.push(...(await queue.claim(workerId, count - got.length, leaseMs)));
      expect(got).toHaveLength(count);
    },
    { timeout: 5_000, interval: 25 },
  );
  return got;
}

/** The queue with claims that wait out CockroachDB's transient SKIP LOCKED misses (for runLeased). */
function settledClaims(queue: LeaseQueue, count: number): LeaseQueue {
  return { ...queue, claim: (workerId, _limit, leaseMs) => claimExactly(queue, workerId, count, leaseMs) };
}

for (const fx of FIXTURES) {
  const { queue, table } = fx;
  const leaseMs = queue.spec.leaseMs;
  const leased = queue.spec.leasedStatus;
  const expire = (ids: string[]) => setLeaseLeft(table, ids, -1_000);

  describe.runIf(dbTestsEnabled())(`db tier: lease queue contract (${fx.name})`, () => {
    beforeEach(() => fx.reset());
    afterEach(() => fx.reset());

    it("claims due rows oldest first up to the limit, charging one attempt and leasing them to the worker", async () => {
      let ids: string[] = [];
      let notDue = "";
      let attempt = 0;
      // Retried as a whole: on CockroachDB a claim right after the insert can
      // skip rows (or let a younger one through) until the insert's intents
      // are resolved, so later attempts give them time before claiming.
      await vi.waitFor(
        async () => {
          attempt++;
          await fx.reset();
          ids = await fx.seed(3);
          notDue = await fx.seedNotDue();
          if (attempt > 1) await sleep(Math.min(2_000, 250 * (attempt - 1)));
          // The oldest rows (the returned ids themselves are unordered).
          expect((await queue.claim("w1", 2)).sort()).toEqual(ids.slice(0, 2).sort());
        },
        { timeout: 20_000, interval: 50 },
      );
      for (const id of ids.slice(0, 2)) {
        const row = await readRow(table, id);
        expect(row).toMatchObject({ status: leased, attempts: 1, owner: "w1" });
        expect(row.leaseLeftMs).toBeGreaterThan(leaseMs - 10_000);
        expect(row.leaseLeftMs).toBeLessThanOrEqual(leaseMs + 1_000);
      }
      expect(await claimExactly(queue, "w2", 1)).toEqual([ids[2]]);
      expect(await queue.claim("w3", 5)).toEqual([]);
      expect((await readRow(table, notDue)).owner).toBeNull();
    });

    it("never gives the same row to two workers claiming at once", async () => {
      const ids = await fx.seed(12);
      const [a, b] = await Promise.all([queue.claim("w1", 12), queue.claim("w2", 12)]);
      const rest = await claimExactly(queue, "w3", 12 - a.length - b.length);
      const all = [...a, ...b, ...rest];
      expect(new Set(all).size).toBe(all.length);
      expect([...all].sort()).toEqual([...ids].sort());
    });

    it("renews and confirms only the owner's leases", async () => {
      const [a, b] = await fx.seed(2);
      await claimExactly(queue, "w1", 2);
      await setLeaseLeft(table, [a!, b!], 1_000);

      expect((await queue.renew("w1", [a!, b!])).sort()).toEqual([a!, b!].sort());
      expect((await readRow(table, a!)).leaseLeftMs).toBeGreaterThan(leaseMs - 10_000);
      expect(await queue.renew("w2", [a!])).toEqual([]);
      expect(await queue.confirm("w2", a!)).toBe(false);
      expect(await queue.confirm("w1", a!)).toBe(true);
    });

    it("writes terminal states only while owned, and clears the lease", async () => {
      const [a, b] = await fx.seed(2);
      await claimExactly(queue, "w1", 2);

      expect(await queue.complete("w2", a!, fx.completeSet)).toBe(false);
      expect(await queue.complete("w1", a!, fx.completeSet)).toBe(true);
      expect(await readRow(table, a!)).toMatchObject({ status: fx.completedStatus, owner: null, leaseLeftMs: null });
      expect(await queue.fail("w1", b!, fx.failSet)).toBe(true);
      expect(await readRow(table, b!)).toMatchObject({ status: fx.failedStatus, owner: null, attempts: 1 });
      // Done rows are no longer leased: a late duplicate write misses.
      expect(await queue.complete("w1", a!, fx.completeSet)).toBe(false);
    });

    it("releases owned rows back to the queue without charging the attempt", async () => {
      const [a, b] = await fx.seed(2);
      await claimExactly(queue, "w1", 2);

      expect(await queue.release("w2", [a!, b!])).toBe(0);
      expect(await queue.release("w1", [a!, b!])).toBe(2);
      for (const id of [a!, b!]) {
        expect(await readRow(table, id)).toEqual({ status: fx.releasedStatus, attempts: 0, owner: null, leaseLeftMs: null });
      }
      expect((await claimExactly(queue, "w2", 2)).sort()).toEqual([a!, b!].sort());
      expect((await readRow(table, a!)).attempts).toBe(1);
    });

    it("recovers expired leases (attempt kept), dead-letters exhausted ones, and leaves live leases alone", async () => {
      const [expired, live] = await fx.seed(2);
      const [exhausted] = await fx.seed(1, { attemptsLeft: 1 });
      await claimExactly(queue, "w1", 3);
      await expire([expired!, exhausted!]);

      expect(await queue.recoverStale()).toEqual({ requeued: 1, deadLettered: 1 });
      expect(await readRow(table, expired!)).toMatchObject({ status: fx.requeuedStatus, attempts: 1, owner: null });
      expect(await readRow(table, exhausted!)).toMatchObject({ status: fx.deadStatus, attempts: MAX_ATTEMPTS, owner: null });
      expect(await readRow(table, live!)).toMatchObject({ status: leased, owner: "w1" });
      // The stalled worker lost the row: its writes miss.
      expect(await queue.confirm("w1", expired!)).toBe(false);
      expect(await queue.complete("w1", expired!, fx.completeSet)).toBe(false);
      // Requeued: another worker claims it, second attempt.
      expect(await claimExactly(queue, "w2", 1)).toEqual([expired]);
      expect((await readRow(table, expired!)).attempts).toBe(2);
      expect(await queue.recoverStale()).toEqual({ requeued: 0, deadLettered: 0 });
    });

    it("reports claimable rows, leases and expired leases", async () => {
      await fx.seed(3);
      await fx.seedNotDue();
      await expire(await claimExactly(queue, "w1", 1));

      const health = await queue.health();
      expect(health).toMatchObject({ claimable: 2, leased: 1, expiredLeases: 1 });
      expect(health.oldestLeaseAgeMs).toBeGreaterThanOrEqual(0);
      expect(health.oldestLeaseAgeMs).toBeLessThan(60_000);
    });

    it("runLeased: the heartbeat keeps a slow row's lease alive past its length", async () => {
      const [slow] = await fx.seed(1);
      let recoveries = 0;
      const result = await runLeased(settledClaims(queue, 1), {
        workerId: "w1",
        limit: 1,
        leaseMs: 1_500,
        renewEveryMs: 250,
        load: async (ids) => ids.map((id) => ({ id })),
        handle: async (row) => {
          // Twice the lease length, with recovery running all along.
          for (let i = 0; i < 6; i++) {
            await sleep(500);
            const r = await queue.recoverStale();
            recoveries += r.requeued + r.deadLettered;
          }
          return queue.complete("w1", row.id, fx.completeSet);
        },
        onError: async () => false,
      });
      expect(recoveries).toBe(0);
      expect(result).toMatchObject({ claimed: 1, handled: 1, leaseLost: 0 });
      expect((await readRow(table, slow!)).status).toBe(fx.completedStatus);
    });

    it("runLeased: an abort releases the claimed rows not started, without an attempt penalty", async () => {
      const ids = await fx.seed(3);
      const controller = new AbortController();
      const result = await runLeased(settledClaims(queue, 3), {
        workerId: "w1",
        limit: 3,
        signal: controller.signal,
        // Processing order is load's: oldest first.
        load: async (claimed) => ids.filter((id) => claimed.includes(id)).map((id) => ({ id })),
        handle: async (row) => {
          controller.abort(new JobTimeoutError("test", 60_000));
          return queue.complete("w1", row.id, fx.completeSet);
        },
        onError: async () => false,
      });
      expect(result).toMatchObject({ claimed: 3, handled: 1, released: 2 });
      expect((await readRow(table, ids[0]!)).status).toBe(fx.completedStatus);
      for (const id of ids.slice(1)) {
        expect(await readRow(table, id)).toEqual({ status: fx.releasedStatus, attempts: 0, owner: null, leaseLeftMs: null });
      }
    });

    it("runLeased: a row taken over after its lease expired is not handled by the stalled worker", async () => {
      const [row] = await fx.seed(1);
      const handled: string[] = [];
      const result = await runLeased(settledClaims(queue, 1), {
        workerId: "w1",
        limit: 1,
        load: async (ids) => {
          // w1 stalls past its lease; recovery requeues the row and w2 claims it.
          await expire(ids);
          await queue.recoverStale();
          expect(await claimExactly(queue, "w2", 1)).toEqual(ids);
          return ids.map((id) => ({ id }));
        },
        handle: async (claimed) => {
          handled.push(claimed.id);
          return true;
        },
        onError: async () => false,
      });
      expect(handled).toEqual([]);
      expect(result).toMatchObject({ claimed: 1, handled: 0, leaseLost: 1, released: 0 });
      expect(await readRow(table, row!)).toMatchObject({ status: leased, owner: "w2", attempts: 2 });
    });
  });
}
