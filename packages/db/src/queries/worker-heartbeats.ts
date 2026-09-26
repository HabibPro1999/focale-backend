import { sql } from "drizzle-orm";
import { getDb, type DbExecutor } from "../client";
import { rowCountOf, rowsOf } from "../helpers";
import { workerHeartbeats, type WorkerJobHeartbeat } from "../schema/worker-heartbeats";

/** A worker is live when its last beat is younger than this (it beats every 15 s). */
export const WORKER_HEARTBEAT_FRESH_MS = 60_000;
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
  exec: DbExecutor,
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
  exec: DbExecutor,
  retentionMs = WORKER_HEARTBEAT_RETENTION_MS,
): Promise<number> {
  const result = await exec.execute(sql`
    DELETE FROM "worker_heartbeats"
    WHERE "last_beat_at" < now() - ${`${Math.floor(retentionMs / 1000)} seconds`}::interval
  `);
  return rowCountOf(result);
}

export interface WorkerHealth {
  isHealthy: boolean;
  /** Why the check failed (empty when healthy). No worker ids, services or job names. */
  reasons: string[];
  counts: {
    /** Enabled workers that beat in the last 60 s. */
    live: number;
    /** Workers that beat in the last 60 s with RUN_WORKERS=false. */
    disabled: number;
    /** Jobs on those workers running past twice their timeout. */
    overdueJobs: number;
  };
}

/**
 * /health/worker (public, unauthenticated): healthy when at least one enabled
 * worker beat in the last 60 s and no live worker reports a job running past
 * 2x its timeout. The body carries counts only; per-worker and per-job detail
 * stays in worker_heartbeats for operators. Ages use the database clock (the
 * workers stamp their beats with it).
 */
export async function getWorkerHealth(exec: DbExecutor = getDb()): Promise<WorkerHealth> {
  const rows = rowsOf<{ disabled: boolean; jobs: Record<string, WorkerJobHeartbeat> | null }>(
    await exec.execute(sql`
      SELECT "disabled", "jobs"
      FROM "worker_heartbeats"
      WHERE "last_beat_at" > now() - ${`${WORKER_HEARTBEAT_FRESH_MS / 1000} seconds`}::interval
    `),
  );

  const counts = { live: 0, disabled: 0, overdueJobs: 0 };
  for (const row of rows) {
    if (row.disabled) counts.disabled++;
    else counts.live++;
    for (const job of Object.values(row.jobs ?? {})) if (job.overdue) counts.overdueJobs++;
  }

  const reasons: string[] = [];
  if (counts.live + counts.disabled === 0) {
    reasons.push(`no worker heartbeat in the last ${WORKER_HEARTBEAT_FRESH_MS / 1000} s`);
  } else if (counts.live === 0) {
    reasons.push("only workers with RUN_WORKERS=false are running; no jobs are processed");
  }
  if (counts.overdueJobs > 0) {
    reasons.push(`${counts.overdueJobs} job run(s) past twice their timeout`);
  }
  return { isHealthy: reasons.length === 0, reasons, counts };
}
