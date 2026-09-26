import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  getDb,
  getWorkerHealth,
  pruneWorkerHeartbeats,
  recordWorkerHeartbeat,
  workerHeartbeats,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";

// 3.3: worker_heartbeats (migration 0023) against a migrated database (both engines in CI).
const job = (overrides: Record<string, unknown> = {}) => ({
  running: false,
  timeoutMs: 60_000,
  overdue: false,
  ...overrides,
});

async function ageRow(workerId: string, seconds: number): Promise<void> {
  await getDb().execute(sql`
    UPDATE worker_heartbeats SET last_beat_at = now() - ${`${seconds} seconds`}::interval
    WHERE worker_id = ${workerId}
  `);
}

describe.runIf(dbTestsEnabled())("db tier: worker heartbeats", () => {
  beforeEach(async () => {
    await getDb().delete(workerHeartbeats);
  });
  afterEach(async () => {
    await getDb().delete(workerHeartbeats);
  });

  it("upserts one row per worker and keeps started_at while last_beat_at moves", async () => {
    await recordWorkerHeartbeat({ workerId: "w1", service: "focale-worker", disabled: false, jobs: { outbox: job() } }, getDb());
    await ageRow("w1", 30);
    await recordWorkerHeartbeat({
      workerId: "w1",
      service: "focale-worker",
      disabled: false,
      jobs: { outbox: job({ running: true, runningForMs: 1_000 }) },
    }, getDb());

    const rows = await getDb().select().from(workerHeartbeats);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.jobs).toEqual({ outbox: job({ running: true, runningForMs: 1_000 }) });
    expect(rows[0]!.startedAt.getTime()).toBeLessThanOrEqual(rows[0]!.lastBeatAt.getTime());
    expect(await getWorkerHealth()).toEqual({
      isHealthy: true,
      reasons: [],
      counts: { live: 1, disabled: 0, overdueJobs: 0 },
    });
  });

  it("is healthy with one fresh enabled worker, even beside a stopped one", async () => {
    await recordWorkerHeartbeat({ workerId: "old", service: "focale-worker", disabled: false, jobs: {} }, getDb());
    await ageRow("old", 120);
    await recordWorkerHeartbeat({ workerId: "new", service: "focale-worker", disabled: false, jobs: { outbox: job() } }, getDb());

    expect(await getWorkerHealth()).toEqual({
      isHealthy: true,
      reasons: [],
      counts: { live: 1, disabled: 0, overdueJobs: 0 },
    });
  });

  it("is unhealthy with no fresh beat, with only disabled workers, or with an overdue job", async () => {
    expect(await getWorkerHealth()).toEqual({
      isHealthy: false,
      reasons: ["no worker heartbeat in the last 60 s"],
      counts: { live: 0, disabled: 0, overdueJobs: 0 },
    });

    await recordWorkerHeartbeat({ workerId: "idle", service: "focale-worker", disabled: true, jobs: {} }, getDb());
    expect(await getWorkerHealth()).toEqual({
      isHealthy: false,
      reasons: ["only workers with RUN_WORKERS=false are running; no jobs are processed"],
      counts: { live: 0, disabled: 1, overdueJobs: 0 },
    });

    await recordWorkerHeartbeat({
      workerId: "busy",
      service: "focale-worker",
      disabled: false,
      jobs: { "email-queue": job({ running: true, runningForMs: 250_000, timeoutMs: 120_000, overdue: true }) },
    }, getDb());
    const health = await getWorkerHealth();
    // Counts only: no worker id, service name or job name in the public body.
    expect(health).toEqual({
      isHealthy: false,
      reasons: ["1 job run(s) past twice their timeout"],
      counts: { live: 1, disabled: 1, overdueJobs: 1 },
    });
    expect(JSON.stringify(health)).not.toMatch(/busy|idle|focale-worker|email-queue/);
  });

  it("ignores workers silent for 60 s and prunes rows older than the retention", async () => {
    await recordWorkerHeartbeat({ workerId: "gone", service: "focale-worker", disabled: false, jobs: {} }, getDb());
    await recordWorkerHeartbeat({ workerId: "recent", service: "focale-worker", disabled: false, jobs: {} }, getDb());
    await ageRow("gone", 8 * 24 * 3600);
    await ageRow("recent", 61);

    expect((await getWorkerHealth()).counts).toEqual({ live: 0, disabled: 0, overdueJobs: 0 });
    expect(await pruneWorkerHeartbeats(getDb())).toBe(1);
    const remaining = await getDb().select({ workerId: workerHeartbeats.workerId }).from(workerHeartbeats);
    expect(remaining).toEqual([{ workerId: "recent" }]);
  });
});
