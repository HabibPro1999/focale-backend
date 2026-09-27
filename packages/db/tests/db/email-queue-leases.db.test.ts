import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  claimQueuedEmailLogs, emailLogs, getClaimedEmailLogsForProcessing, getDb,
  markEmailFailed, markEmailSent, markEmailSkipped, recoverStaleEmailLeases,
  refreshEmailLease, writeResolvedSubjectIfLeaseHeld,
} from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { cleanupDatabase } from "../helpers/cleanup";

const now = new Date("2030-01-02T03:04:05.000Z");
const at = (ms: number) => new Date(now.getTime() + ms);
const worker = "email-queue-characterization";

async function seed(overrides: Partial<typeof emailLogs.$inferInsert> = {}) {
  const [row] = await getDb().insert(emailLogs).values({
    recipientEmail: "recipient@example.test", subject: "original", queuedAt: at(-1000),
    updatedAt: now, ...overrides,
  }).returning();
  return row;
}
async function read(id: string) {
  const [row] = await getDb().select().from(emailLogs).where(eq(emailLogs.id, id));
  return row;
}
async function sending(overrides: Partial<typeof emailLogs.$inferInsert> = {}) {
  return seed({ status: "SENDING", lockedBy: worker, lockedAt: at(-1000), lockedUntil: at(1000), ...overrides });
}

describe.runIf(dbTestsEnabled())("email queue SQL and lease behavior", () => {
  const originalTimezone = process.env.TZ;
  // The production image runs in UTC. Raw pg Date parameters otherwise use
  // the process's local wall time for these timestamp-without-time-zone columns.
  beforeAll(() => { process.env.TZ = "UTC"; });
  afterAll(() => {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  });
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it("claims oldest eligible due rows, accepts the attempt boundary and excludes networking", async () => {
    const oldest = await seed({ queuedAt: at(-3000), attemptCount: 3, maxRetries: 3, errorMessage: "old failure" });
    const due = await seed({ queuedAt: at(-2000), nextAttemptAt: now });
    const future = await seed({ nextAttemptAt: at(1) });
    const exhausted = await seed({ attemptCount: 4, maxRetries: 3 });
    const networking = await seed({ contextSnapshot: { dispatchOwner: "networking" } });
    expect(await claimQueuedEmailLogs(worker, 1, now, at(60_000))).toEqual([oldest.id]);
    expect(await read(oldest.id)).toMatchObject({ status: "SENDING", lockedBy: worker, lockedAt: now, lockedUntil: at(60_000), lastAttemptAt: now, attemptCount: 4, retryCount: 0, errorMessage: null });
    expect(await claimQueuedEmailLogs(worker, 10, now, at(60_000))).toEqual([due.id]);
    for (const row of [future, exhausted, networking]) expect((await read(row.id)).status).toBe("QUEUED");
  });

  it("parallel claims never claim one row twice and processing rechecks ownership", async () => {
    const rows = await Promise.all([0, 1, 2, 3].map(i => seed({ queuedAt: at(-4000 + i * 1000) })));
    const [a, b] = await Promise.all([
      claimQueuedEmailLogs("a", 2, now, at(60_000)),
      claimQueuedEmailLogs("b", 2, now, at(60_000)),
    ]);
    expect(new Set([...a, ...b]).size).toBe(4);
    expect([...a, ...b].sort()).toEqual(rows.map(row => row.id).sort());
    expect((await getClaimedEmailLogsForProcessing("a", [...a, ...b])).map(row => row.id).sort()).toEqual(a.sort());
    expect(await getClaimedEmailLogsForProcessing("other", [...a, ...b])).toEqual([]);
  });

  it.each([
    { attempt: 1, max: 3, delay: 60_000 },
    { attempt: 2, max: 3, delay: 300_000 },
    { attempt: 3, max: 3, delay: 900_000 },
    { attempt: 4, max: 3, delay: null },
    { attempt: 1, max: 0, delay: null },
  ])("failure attempt $attempt/max $max keeps retry counters and backoff distinct", async ({ attempt, max, delay }) => {
    const row = await sending({ attemptCount: attempt, retryCount: 7, maxRetries: max, lockedUntil: at(-1) });
    expect(await markEmailFailed(row.id, worker, "provider failed", attempt, max, now)).toBe(true);
    expect(await read(row.id)).toMatchObject({
      status: delay === null ? "FAILED" : "QUEUED", attemptCount: attempt, retryCount: 8,
      failedAt: delay === null ? now : null, nextAttemptAt: delay === null ? null : at(delay),
      lockedAt: null, lockedUntil: null, lockedBy: null, errorMessage: "provider failed", updatedAt: now,
    });
  });

  it("wrong owners cannot write, refresh or finish a lease", async () => {
    const row = await sending();
    expect(await writeResolvedSubjectIfLeaseHeld(row.id, "other", "changed", now)).toBe(false);
    expect(await refreshEmailLease(row.id, "other", now, 60_000)).toBe(false);
    expect(await markEmailFailed(row.id, "other", "failure", 1, 3, now)).toBe(false);
    expect(await markEmailSent(row.id, "other", "provider-id", now)).toBe(false);
    expect(await markEmailSkipped(row.id, "other", "skip", now)).toBe(false);
    expect(await read(row.id)).toEqual(row);
  });

  it("requires unexpired leases for subject/refresh but not for terminal marks", async () => {
    const expired = await sending({ lockedUntil: now });
    expect(await writeResolvedSubjectIfLeaseHeld(expired.id, worker, "changed", now)).toBe(false);
    expect(await refreshEmailLease(expired.id, worker, now, 60_000)).toBe(false);
    expect(await markEmailSent(expired.id, worker, undefined, now)).toBe(true);
    expect(await read(expired.id)).toMatchObject({ status: "SENT", sentAt: now, providerMessageId: null, lockedBy: null, lockedUntil: null });
    expect(await markEmailFailed(expired.id, worker, "late", 1, 3, now)).toBe(false);
    const active = await sending();
    expect(await writeResolvedSubjectIfLeaseHeld(active.id, worker, "resolved", now)).toBe(true);
    expect(await refreshEmailLease(active.id, worker, now, 120_000)).toBe(true);
    expect(await read(active.id)).toMatchObject({ subject: "resolved", lockedAt: now, lockedUntil: at(120_000) });
    expect(await markEmailSkipped(active.id, worker, "no template", now)).toBe(true);
    expect(await read(active.id)).toMatchObject({ status: "SKIPPED", errorMessage: "no template", lockedBy: null, lockedAt: null, lockedUntil: null, nextAttemptAt: null });
  });

  it("recovery uses retryCount, preserves provider errors and excludes networking/expiry equality", async () => {
    const retry = await sending({ lockedUntil: at(-1), attemptCount: 100, retryCount: 1, maxRetries: 3, errorMessage: "provider detail" });
    const fail = await sending({ lockedUntil: at(-1), attemptCount: 0, retryCount: 3, maxRetries: 3 });
    const boundary = await sending({ lockedUntil: now });
    const networking = await sending({ lockedUntil: at(-1), contextSnapshot: { dispatchOwner: "networking" } });
    expect(await recoverStaleEmailLeases(now, 60_000)).toEqual({ requeued: 1, deadLettered: 1 });
    expect(await read(retry.id)).toMatchObject({ status: "QUEUED", attemptCount: 100, retryCount: 2, nextAttemptAt: at(300_000), errorMessage: "provider detail", lockedBy: null });
    expect(await read(fail.id)).toMatchObject({ status: "FAILED", attemptCount: 0, retryCount: 4, failedAt: now, nextAttemptAt: null, errorMessage: "Email send lease expired and retry limit was exhausted" });
    expect(await read(boundary.id)).toEqual(boundary);
    expect(await read(networking.id)).toEqual(networking);
    expect(await recoverStaleEmailLeases(now, 60_000)).toEqual({ requeued: 0, deadLettered: 0 });
  });

  it.each(["lockedAt", "lastAttemptAt", "updatedAt"] as const)("uses %s fallback for rows without lockedUntil and keeps the strict stale cutoff", async (key) => {
    const base = { lockedUntil: null, lockedAt: null, lastAttemptAt: null };
    const stale = await sending({ ...base, [key]: at(-60_001) });
    const equal = await sending({ ...base, [key]: at(-60_000) });
    expect(await recoverStaleEmailLeases(now, 60_000)).toEqual({ requeued: 1, deadLettered: 0 });
    expect(await read(stale.id)).toMatchObject({ status: "QUEUED", retryCount: 1, nextAttemptAt: at(60_000), errorMessage: "Email send lease expired; requeued for retry" });
    expect(await read(equal.id)).toEqual(equal);
  });

  it("documents the existing local-time shift for raw Date parameters outside UTC", async () => {
    const row = await sending();
    process.env.TZ = "Africa/Tunis";
    try {
      expect(await markEmailSent(row.id, worker, "provider", now)).toBe(true);
      expect((await read(row.id)).sentAt).toEqual(at(3_600_000));
    } finally {
      process.env.TZ = "UTC";
    }
  });
});
