import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  DB_NOW,
  emailLogs,
  getClaimedEmailLogsForProcessing,
  getDb,
  markEmailFailed,
  rowsOf,
  writeResolvedSubjectIfLeaseHeld,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";

// Email-specific wrappers, supplementing lease-queue.db.test.ts. These tests
// do not claim/recover generic queue rows or change the two retry counters.
const WORKER = "email-failure-boundaries";
const PROVIDER_ERROR = "550 recipient rejected: provider detail";

async function seedSending(options: {
  attemptCount?: number;
  retryCount?: number;
  lockedBy?: string;
  status?: "SENDING" | "SENT";
  expired?: boolean;
  queuedSecondsAgo?: number;
} = {}) {
  const [row] = await getDb()
    .insert(emailLogs)
    .values({
      recipientEmail: "failure-boundary@example.test",
      subject: "unresolved",
      status: options.status ?? "SENDING",
      attemptCount: options.attemptCount ?? 1,
      retryCount: options.retryCount ?? 7,
      maxRetries: 3,
      errorMessage: "previous provider error",
      lockedBy: options.lockedBy ?? WORKER,
      lockedAt: sql`${DB_NOW} - interval '2 minutes'`,
      lockedUntil: options.expired
        ? sql`${DB_NOW} - interval '1 minute'`
        : sql`${DB_NOW} + interval '10 minutes'`,
      lastAttemptAt: sql`${DB_NOW} - interval '2 minutes'`,
      // Stale values must be overwritten or cleared by the failure branch.
      failedAt: sql`${DB_NOW} - interval '2 hours'`,
      nextAttemptAt: sql`${DB_NOW} + interval '2 hours'`,
      queuedAt: sql`${DB_NOW} - ${`${options.queuedSecondsAgo ?? 120} seconds`}::interval`,
      updatedAt: sql`${DB_NOW} - interval '2 minutes'`,
    })
    .returning();
  return row!;
}

async function readLog(id: string) {
  const [row] = await getDb().select().from(emailLogs).where(eq(emailLogs.id, id));
  return row!;
}

/** Compare only database-clock instants, never host time or elapsed sleeps. */
async function databaseNowMs(): Promise<number> {
  const result = await getDb().execute(sql`
    SELECT (EXTRACT(EPOCH FROM ${DB_NOW}) * 1000)::float8 AS now_ms
  `);
  return Number(rowsOf<{ now_ms: number | string }>(result)[0]!.now_ms);
}

function expectDbTimestampBetween(value: Date | null, before: number, after: number) {
  expect(value).toBeInstanceOf(Date);
  // timestamp(3) rounds to milliseconds; allow that rounding at each bound.
  expect(value!.getTime()).toBeGreaterThanOrEqual(Math.floor(before) - 1);
  expect(value!.getTime()).toBeLessThanOrEqual(Math.ceil(after) + 1);
}

describe.runIf(dbTestsEnabled())("db tier: email failure and ownership boundaries", () => {
  beforeEach(async () => { await getDb().delete(emailLogs); });
  afterEach(async () => { await getDb().delete(emailLogs); });

  it.each([
    { attempt: 1, retries: 7, status: "QUEUED", delayMs: 60_000 },
    { attempt: 2, retries: 0, status: "QUEUED", delayMs: 300_000 },
    { attempt: 3, retries: 1, status: "QUEUED", delayMs: 900_000 },
    { attempt: 4, retries: 0, status: "FAILED", delayMs: null },
  ] as const)(
    "failure at attempt $attempt/max 3 writes $status and increments the separate retry count",
    async ({ attempt, retries, status, delayMs }) => {
      const seeded = await seedSending({ attemptCount: attempt, retryCount: retries });
      const before = await databaseNowMs();

      expect(await markEmailFailed(seeded.id, WORKER, PROVIDER_ERROR, attempt, 3)).toBe(true);

      const after = await databaseNowMs();
      const stored = await readLog(seeded.id);
      expect(stored).toMatchObject({
        status,
        attemptCount: attempt,
        retryCount: retries + 1,
        maxRetries: 3,
        errorMessage: PROVIDER_ERROR,
        subject: "unresolved",
        lockedAt: null,
        lockedUntil: null,
        lockedBy: null,
        lastAttemptAt: seeded.lastAttemptAt,
      });
      expectDbTimestampBetween(stored.updatedAt, before, after);
      if (delayMs === null) {
        expect(stored.nextAttemptAt).toBeNull();
        expectDbTimestampBetween(stored.failedAt, before, after);
      } else {
        expect(stored.failedAt).toBeNull();
        expectDbTimestampBetween(stored.nextAttemptAt, before + delayMs, after + delayMs);
        // Both are stamped by the same statement: the schedule is exact even
        // if the surrounding read queries are slow on a loaded DB service.
        expect(stored.nextAttemptAt!.getTime() - stored.updatedAt.getTime()).toBe(delayMs);
      }
    },
  );

  it.each([
    { boundary: "another owner", lockedBy: "another-worker", status: "SENDING" },
    { boundary: "no longer SENDING", lockedBy: WORKER, status: "SENT" },
  ] as const)("rejects subject and failure writes when $boundary", async ({ lockedBy, status }) => {
    const seeded = await seedSending({ lockedBy, status });

    expect(await writeResolvedSubjectIfLeaseHeld(seeded.id, WORKER, "resolved")).toBe(false);
    expect(await markEmailFailed(seeded.id, WORKER, PROVIDER_ERROR, 1, 3)).toBe(false);

    expect(await readLog(seeded.id)).toEqual(seeded);
  });

  it("allows subject and failure writes after expiry while the row is still owned and SENDING", async () => {
    const seeded = await seedSending({ expired: true });
    // Expiry makes a row recoverable; recovery, not elapsed time alone,
    // removes its owner. The email wrappers preserve that current boundary.
    expect(await writeResolvedSubjectIfLeaseHeld(seeded.id, WORKER, "resolved")).toBe(true);
    expect(await readLog(seeded.id)).toMatchObject({
      subject: "resolved",
      status: "SENDING",
      lockedBy: WORKER,
      lockedUntil: seeded.lockedUntil,
    });

    expect(await markEmailFailed(seeded.id, WORKER, PROVIDER_ERROR, 1, 3)).toBe(true);
    expect(await readLog(seeded.id)).toMatchObject({
      subject: "resolved",
      status: "QUEUED",
      attemptCount: 1,
      retryCount: 8,
      errorMessage: PROVIDER_ERROR,
      failedAt: null,
      lockedAt: null,
      lockedUntil: null,
      lockedBy: null,
    });
  });

  it("re-filters claimed ids by current owner and status, in queued order, without an expiry filter", async () => {
    const newest = await seedSending({ queuedSecondsAgo: 30 });
    const expired = await seedSending({ expired: true, queuedSecondsAgo: 120 });
    const otherOwner = await seedSending({ lockedBy: "another-worker", queuedSecondsAgo: 180 });
    const completed = await seedSending({ status: "SENT", queuedSecondsAgo: 240 });

    const loaded = await getClaimedEmailLogsForProcessing(WORKER, [
      newest.id, completed.id, otherOwner.id, expired.id,
    ]);

    expect(loaded.map((row) => row.id)).toEqual([expired.id, newest.id]);
    expect(loaded).toEqual([
      expect.objectContaining({ attemptCount: 1, maxRetries: 3, template: null, registration: null }),
      expect.objectContaining({ attemptCount: 1, maxRetries: 3, template: null, registration: null }),
    ]);
  });
});
