// Abort reasons of worker job runs, shared so queue code outside the worker
// app (the @app/db lease queue) can tell a shutdown from a timeout.

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
export function abortedForShutdown(signal: AbortSignal | undefined): boolean {
  return Boolean(signal?.aborted) && signal!.reason instanceof WorkerShutdownError;
}
