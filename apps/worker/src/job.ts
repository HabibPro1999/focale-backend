import type { Logger } from "@app/shared";

/** What the runner hands every run. */
export interface JobContext {
  /**
   * Aborted when the run exceeds the job's timeoutMs (reason: JobTimeoutError)
   * or when worker shutdown reaches its deadline (reason: WorkerShutdownError).
   * Jobs pass it down and stop at the next safe point; the runner never starts
   * another run of the same job before this one settles.
   */
  signal: AbortSignal;
  /** Epoch ms at which this run times out (start + timeoutMs). */
  deadline: number;
  /** Logger bound to the job name. */
  log: Logger;
}

/** A recurring background job. */
export interface Job {
  name: string;
  intervalMs: number;
  /** Per-run budget; ctx.signal aborts once it is exceeded. */
  timeoutMs: number;
  run(ctx: JobContext): Promise<void>;
}

/** Abort reason when a run exceeds its timeoutMs. */
export class JobTimeoutError extends Error {
  constructor(readonly job: string, readonly timeoutMs: number) {
    super(`Job ${job} exceeded its ${timeoutMs} ms timeout`);
    this.name = "JobTimeoutError";
  }
}

/** Abort reason when worker shutdown reaches its deadline. */
export class WorkerShutdownError extends Error {
  constructor() {
    super("Worker shutdown deadline reached");
    this.name = "WorkerShutdownError";
  }
}

/** True when `signal` was aborted by worker shutdown (not by the job's own timeout). */
export function abortedForShutdown(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof WorkerShutdownError;
}

/** Multi-provider DI token collecting all registered jobs. */
export const JOBS = Symbol("JOBS");
