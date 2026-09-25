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
    await recordWorkerHeartbeat({ workerId: "w1", service: "focale-worker", disabled: false, jobs: { outbox: job() } });
    await ageRow("w1", 30);
    await recordWorkerHeartbeat({
      workerId: "w1",
      service: "focale-worker",
      disabled: false,
      jobs: { outbox: job({ running: true, runningForMs: 1_000 }) },
    });

    const rows = await getDb().select().from(workerHeartbeats);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.jobs).toEqual({ outbox: job({ running: true, runningForMs: 1_000 }) });
    expect(rows[0]!.startedAt.getTime()).toBeLessThanOrEqual(rows[0]!.lastBeatAt.getTime());
    const health = await getWorkerHealth();
    expect(health.workers[0]!.lastBeatAgeMs).toBeLessThan(5_000);
    expect(health.workers[0]!.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it("is healthy with one fresh enabled worker, even beside a stopped one", async () => {
    await recordWorkerHeartbeat({ workerId: "old", service: "focale-worker", disabled: false, jobs: {} });
    await ageRow("old", 120);
    await recordWorkerHeartbeat({ workerId: "new", service: "focale-worker", disabled: false, jobs: { outbox: job() } });

    const health = await getWorkerHealth();
    expect(health).toMatchObject({ isHealthy: true, reasons: [] });
    expect(health.workers.map((worker) => [worker.workerId, worker.fresh])).toEqual([
      ["new", true],
      ["old", false],
    ]);
  });

  it("is unhealthy with no fresh beat, with only disabled workers, or with an overdue job", async () => {
    expect(await getWorkerHealth()).toMatchObject({
      isHealthy: false,
      reasons: ["no worker heartbeat in the last 60 s"],
      workers: [],
    });

    await recordWorkerHeartbeat({ workerId: "idle", service: "focale-worker", disabled: true, jobs: {} });
    expect((await getWorkerHealth()).reasons).toEqual([
      "only workers with RUN_WORKERS=false are running; no jobs are processed",
    ]);

    await recordWorkerHeartbeat({
      workerId: "busy",
      service: "focale-worker",
      disabled: false,
      jobs: { "email-queue": job({ running: true, runningForMs: 250_000, timeoutMs: 120_000, overdue: true }) },
    });
    const health = await getWorkerHealth();
    expect(health.isHealthy).toBe(false);
    expect(health.reasons).toEqual(["job email-queue on busy has run for over twice its 120000 ms timeout"]);
  });

  it("stops listing workers silent for 10 minutes and prunes rows older than the retention", async () => {
    await recordWorkerHeartbeat({ workerId: "gone", service: "focale-worker", disabled: false, jobs: {} });
    await recordWorkerHeartbeat({ workerId: "recent", service: "focale-worker", disabled: false, jobs: {} });
    await ageRow("gone", 8 * 24 * 3600);
    await ageRow("recent", 11 * 60);

    expect((await getWorkerHealth()).workers).toEqual([]);
    expect(await pruneWorkerHeartbeats()).toBe(1);
    const remaining = await getDb().select({ workerId: workerHeartbeats.workerId }).from(workerHeartbeats);
    expect(remaining).toEqual([{ workerId: "recent" }]);
  });
});
