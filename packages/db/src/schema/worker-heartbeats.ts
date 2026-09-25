import { boolean, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const instant = () => timestamp({ precision: 3, withTimezone: true });

/** Per-job state a worker reports with each beat (see apps/worker job-runner). */
export interface WorkerJobHeartbeat {
  running: boolean;
  /** How long the current run has been going (ms), when running. */
  runningForMs?: number;
  timeoutMs: number;
  /** Running for more than 2x its timeout: /health/worker reports it. */
  overdue: boolean;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastOutcome?: "ok" | "failed" | "timed-out" | "aborted";
}

/** Migration 0023: one row per worker process, upserted on every heartbeat. */
export const workerHeartbeats = pgTable(
  "worker_heartbeats",
  {
    workerId: text().primaryKey(),
    service: text().notNull(),
    startedAt: instant().notNull().defaultNow(),
    lastBeatAt: instant().notNull().defaultNow(),
    disabled: boolean().notNull().default(false),
    jobs: jsonb().$type<Record<string, WorkerJobHeartbeat>>().notNull().default({}),
  },
  (t) => [index("worker_heartbeats_last_beat_at_idx").on(t.lastBeatAt)],
);
