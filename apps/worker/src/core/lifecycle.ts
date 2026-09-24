import { writeFile } from "node:fs/promises";
import { SHUTDOWN_FORCE_CLOSE_LEAD_MS, WORKER_HEARTBEAT_INTERVAL_MS } from "@app/contracts";

interface LifecycleLogger {
  info(details: object, message: string): void;
  info(message: string): void;
  warn(details: object, message: string): void;
  error(details: object, message: string): void;
}

/**
 * Liveness file for the image HEALTHCHECK (healthcheck.mjs checks its age).
 * Written on start and every interval from its own timer, which also keeps an
 * idle (RUN_WORKERS=false) worker process alive. The file body records
 * whether jobs are disabled. Plan item 3.3 adds the database heartbeat.
 */
export class WorkerHeartbeat {
  private timer: NodeJS.Timeout | undefined;
  private failing = false;

  constructor(
    private readonly file: string,
    private readonly logger: LifecycleLogger,
    private readonly intervalMs = WORKER_HEARTBEAT_INTERVAL_MS,
  ) {}

  start(state: { disabled: boolean }): void {
    if (this.timer) return;
    const beat = () => void this.beat(state.disabled);
    beat();
    // Not unref'd: an idle (disabled) worker has nothing else keeping it alive.
    this.timer = setInterval(beat, this.intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async beat(disabled: boolean): Promise<void> {
    try {
      await writeFile(
        this.file,
        JSON.stringify({ pid: process.pid, at: new Date().toISOString(), disabled }),
      );
      if (this.failing) this.logger.info({ file: this.file }, "worker heartbeat file writable again");
      this.failing = false;
    } catch (err) {
      if (!this.failing) this.logger.error({ err, file: this.file }, "worker heartbeat write failed");
      this.failing = true;
    }
  }
}

export interface WorkerShutdownSteps {
  /** SHUTDOWN_GRACE_MS: the process hard-exits when it runs out. */
  graceMs: number;
  /** Stop scheduling and wait for running jobs until the deadline (absent when RUN_WORKERS=false). */
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
 * Jobs get until grace − 5 s to finish (then they are abandoned and the exit
 * code is 1), the context and the pool close, and the process hard-exits at
 * grace whatever is still pending.
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
    try {
      await steps.closeDb();
    } catch (err) {
      exitCode = 1;
      logger.error({ err }, "database pool close failed");
    }
    steps.heartbeat.stop();
    clearTimeout(hardExitTimer);
    logger.info({ exitCode }, "worker stopped");
    steps.exit(exitCode);
  };

  return (signal: string) => {
    shutdown ??= run(signal);
    return shutdown;
  };
}
