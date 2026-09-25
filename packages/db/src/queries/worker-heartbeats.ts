import { sql } from "drizzle-orm";
import { getDb, type DbExecutor } from "../client";
import { rowCountOf, rowsOf } from "../helpers";
import { workerHeartbeats, type WorkerJobHeartbeat } from "../schema/worker-heartbeats";

/** A worker is live when its last beat is younger than this (it beats every 15 s). */
export const WORKER_HEARTBEAT_FRESH_MS = 60_000;
/** /health/worker lists workers that beat within this window (recently stopped ones included). */
export const WORKER_HEARTBEAT_REPORT_WINDOW_MS = 10 * 60_000;
/** Rows of processes silent for this long are pruned. */
export const WORKER_HEARTBEAT_RETENTION_MS = 7 * 24 * 60 * 60_000;

export interface WorkerHeartbeatInput {
  workerId: string;
  service: string;
  disabled: boolean;
  jobs: Record<string, WorkerJobHeartbeat>;
}

/** Upsert this process's row; the database clock stamps last_beat_at. */
export async function recordWorkerHeartbeat(
  beat: WorkerHeartbeatInput,
  exec: DbExecutor = getDb(),
): Promise<void> {
  await exec
    .insert(workerHeartbeats)
    .values({ workerId: beat.workerId, service: beat.service, disabled: beat.disabled, jobs: beat.jobs })
    .onConflictDoUpdate({
      target: workerHeartbeats.workerId,
      set: {
        service: beat.service,
        disabled: beat.disabled,
        jobs: beat.jobs,
        lastBeatAt: sql`now()`,
      },
    });
}

/** Delete rows of workers silent for longer than `retentionMs`; returns the count. */
export async function pruneWorkerHeartbeats(
  retentionMs = WORKER_HEARTBEAT_RETENTION_MS,
  exec: DbExecutor = getDb(),
): Promise<number> {
  const result = await exec.execute(sql`
    DELETE FROM "worker_heartbeats"
    WHERE "last_beat_at" < now() - ${`${Math.floor(retentionMs / 1000)} seconds`}::interval
  `);
  return rowCountOf(result);
}

export interface WorkerHeartbeatStatus {
  workerId: string;
  service: string;
  disabled: boolean;
  lastBeatAgeMs: number;
  uptimeMs: number;
  fresh: boolean;
  jobs: Record<string, WorkerJobHeartbeat>;
}

export interface WorkerHealth {
  isHealthy: boolean;
  /** Why the check failed (empty when healthy). */
  reasons: string[];
  workers: WorkerHeartbeatStatus[];
}

/**
 * /health/worker: healthy when at least one enabled worker beat in the last
 * 60 s and no live worker reports a job running past 2x its timeout. Ages are
 * computed with the database clock (the workers stamp their beats with it).
 */
export async function getWorkerHealth(exec: DbExecutor = getDb()): Promise<WorkerHealth> {
  const rows = rowsOf<{
    worker_id: string;
    service: string;
    disabled: boolean;
    jobs: Record<string, WorkerJobHeartbeat> | null;
    age_ms: number | string;
    uptime_ms: number | string;
  }>(
    await exec.execute(sql`
      SELECT "worker_id", "service", "disabled", "jobs",
             (EXTRACT(EPOCH FROM (now() - "last_beat_at")) * 1000)::float8 AS age_ms,
             (EXTRACT(EPOCH FROM (now() - "started_at")) * 1000)::float8 AS uptime_ms
      FROM "worker_heartbeats"
      WHERE "last_beat_at" > now() - ${`${WORKER_HEARTBEAT_REPORT_WINDOW_MS / 1000} seconds`}::interval
      ORDER BY "last_beat_at" DESC
    `),
  );

  const workers: WorkerHeartbeatStatus[] = rows.map((row) => {
    const lastBeatAgeMs = Math.max(0, Math.round(Number(row.age_ms)));
    return {
      workerId: row.worker_id,
      service: row.service,
      disabled: Boolean(row.disabled),
      lastBeatAgeMs,
      uptimeMs: Math.max(0, Math.round(Number(row.uptime_ms))),
      fresh: lastBeatAgeMs < WORKER_HEARTBEAT_FRESH_MS,
      jobs: row.jobs ?? {},
    };
  });

  const reasons: string[] = [];
  const live = workers.filter((worker) => worker.fresh);
  if (live.length === 0) {
    reasons.push(`no worker heartbeat in the last ${WORKER_HEARTBEAT_FRESH_MS / 1000} s`);
  } else if (live.every((worker) => worker.disabled)) {
    reasons.push("only workers with RUN_WORKERS=false are running; no jobs are processed");
  }
  for (const worker of live) {
    for (const [name, job] of Object.entries(worker.jobs)) {
      if (job.overdue) {
        reasons.push(`job ${name} on ${worker.workerId} has run for over twice its ${job.timeoutMs} ms timeout`);
      }
    }
  }
  return { isHealthy: reasons.length === 0, reasons, workers };
}
