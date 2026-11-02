import { writeFile } from "node:fs/promises";
import { SHUTDOWN_FORCE_CLOSE_LEAD_MS, WORKER_HEARTBEAT_INTERVAL_MS } from "@app/contracts";
import type { WorkerJobHeartbeat } from "@app/db";

interface LifecycleLogger {
  info(details: object, message: string): void;
  info(message: string): void;
  warn(details: object, message: string): void;
  error(details: object, message: string): void;
}

export interface HeartbeatState {
  disabled: boolean;
  jobs: Record<string, WorkerJobHeartbeat>;
}

export interface WorkerHeartbeatOptions {
  /** Liveness file for the image HEALTHCHECK (healthcheck.mjs checks its age). */
  file: string;
  logger: LifecycleLogger;
  /** Upsert this process's worker_heartbeats row (read by /health/worker). */
  record?: (state: HeartbeatState) => Promise<void>;
  /** Housekeeping run once at start (prunes rows of long-gone workers). */
  prune?: () => Promise<number>;
  intervalMs?: number;
}

/**
 * One heartbeat, two outputs: every beat touches the liveness file (process
 * alive) and upserts the worker_heartbeats row (process alive, database
 * reachable, per-job state). One timer drives both; it also keeps an idle
 * (RUN_WORKERS=false) worker process alive. A slow database write never
 * delays the file, and a new DB write is skipped while the previous one is
 * still pending.
 */
export class WorkerHeartbeat {
  private timer: NodeJS.Timeout | undefined;
  private fileFailing = false;
  private dbFailing = false;
  private dbWrite: Promise<void> | undefined;

  constructor(private readonly options: WorkerHeartbeatOptions) {}

  start(state: { disabled: boolean; jobs?: () => Record<string, WorkerJobHeartbeat> }): void {
    if (this.timer) return;
    const beat = () => this.beat({ disabled: state.disabled, jobs: state.jobs?.() ?? {} });
    void beat();
    // Not unref'd: an idle (disabled) worker has nothing else keeping it alive.
    this.timer = setInterval(() => void beat(), this.options.intervalMs ?? WORKER_HEARTBEAT_INTERVAL_MS);
    void this.options.prune?.().then(
      (pruned) => {
        if (pruned) this.options.logger.info({ pruned }, "pruned stale worker heartbeat rows");
      },
      (err) => this.options.logger.warn({ err }, "pruning stale worker heartbeat rows failed"),
    );
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One beat: file and database row (exposed for tests). */
  async beat(state: HeartbeatState): Promise<void> {
    await Promise.all([this.writeFile(state), this.writeRow(state)]);
  }

  private async writeFile(state: HeartbeatState): Promise<void> {
    const { file, logger } = this.options;
    try {
      await writeFile(
        file,
        JSON.stringify({ pid: process.pid, at: new Date().toISOString(), disabled: state.disabled }),
      );
      if (this.fileFailing) logger.info({ file }, "worker heartbeat file writable again");
      this.fileFailing = false;
    } catch (err) {
      if (!this.fileFailing) logger.error({ err, file }, "worker heartbeat write failed");
      this.fileFailing = true;
    }
  }

  private writeRow(state: HeartbeatState): Promise<void> {
    const { record, logger } = this.options;
    if (!record || this.dbWrite) return Promise.resolve();
    this.dbWrite = record(state).then(
      () => {
        if (this.dbFailing) logger.info("worker heartbeat row recorded again");
        this.dbFailing = false;
      },
      (err: unknown) => {
        if (!this.dbFailing) logger.error({ err }, "worker heartbeat row write failed");
        this.dbFailing = true;
      },
    ).finally(() => {
      this.dbWrite = undefined;
    });
    return this.dbWrite;
  }
}

export interface WorkerShutdownSteps {
  /** SHUTDOWN_GRACE_MS: the process hard-exits when it runs out. */
  graceMs: number;
  /**
   * Stop scheduling, wait for running jobs until the deadline, then abort them
   * through their signal (absent when RUN_WORKERS=false).
   */
  stopRunner?: (deadline: number) => Promise<{ unfinished: string[] }>;
  /** Close the Nest application context (absent when RUN_WORKERS=false). */
  closeContext?: () => Promise<void>;
  closeDb: () => Promise<void>;
  heartbeat: { stop(): void };
  exit: (code: number) => void;
  logger: LifecycleLogger;
  now?: () => number;
}

/**
 * One graceful worker shutdown per process; later signals are ignored.
 * Jobs get until grace − 5 s to finish; then the runner aborts them through
 * their signal and gives them a few seconds to settle (any still running make
 * the exit code 1). The context and the pool close, and the process
 * hard-exits at grace whatever is still pending.
 */
export function createWorkerShutdown(steps: WorkerShutdownSteps): (signal: string) => Promise<void> {
  let shutdown: Promise<void> | undefined;
  const now = steps.now ?? Date.now;

  const run = async (signal: string): Promise<void> => {
    const { graceMs, logger } = steps;
    logger.info({ signal, graceMs }, "worker shutting down");
    // Not unref'd: it must fire even if nothing else keeps the loop alive.
    const hardExitTimer = setTimeout(() => {
      logger.error({ graceMs }, "worker shutdown grace period exhausted; exiting");
      steps.exit(1);
    }, graceMs);

    let exitCode = 0;
    try {
      if (steps.stopRunner) {
        const deadline = now() + Math.max(0, graceMs - SHUTDOWN_FORCE_CLOSE_LEAD_MS);
        const { unfinished } = await steps.stopRunner(deadline);
        if (unfinished.length) exitCode = 1;
      }
      await steps.closeContext?.();
    } catch (err) {
      exitCode = 1;
      logger.error({ err }, "worker shutdown failed");
    }
    // Before the pool closes: a later beat would open a new pool.
    steps.heartbeat.stop();
    try {
      await steps.closeDb();
    } catch (err) {
      exitCode = 1;
      logger.error({ err }, "database pool close failed");
    }
    clearTimeout(hardExitTimer);
    logger.info({ exitCode }, "worker stopped");
    steps.exit(exitCode);
  };

  return (signal: string) => {
    shutdown ??= run(signal);
    return shutdown;
  };
}
