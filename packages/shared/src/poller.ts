import { createLogger } from "./logger";

const logger = createLogger({ name: "poller" });

export interface PollerOptions {
  name: string;
  intervalMs: number;
  work: () => Promise<void>;
  /** Aborting it stops scheduling, exactly like stop() (an in-flight run is not awaited). */
  signal?: AbortSignal;
}

export interface Poller {
  stop: () => Promise<void>;
}

/**
 * setInterval loop with overlap protection: a tick is skipped while a previous
 * `work()` is still in flight. Errors are caught+logged (never crash the loop).
 * First run happens after the first `intervalMs`, not immediately. `stop()` is
 * idempotent, clears the interval, and awaits any in-flight run before returning.
 * An aborted `signal` stops scheduling the same way (callers that also need to
 * wait for the in-flight run call stop()). Ported from the legacy
 * `src/shared/utils/poller.ts`.
 */
export function startPoller({ name, intervalMs, work, signal }: PollerOptions): Poller {
  let inFlight: Promise<void> | null = null;
  let stopping = false;

  const timer = setInterval(() => {
    if (stopping || inFlight) return;
    inFlight = work()
      .catch((err) => {
        logger.error({ err, poller: name }, `${name} processing failed`);
      })
      .finally(() => {
        inFlight = null;
      });
  }, intervalMs);

  const halt = (): boolean => {
    if (stopping) return false;
    stopping = true;
    clearInterval(timer);
    signal?.removeEventListener("abort", halt);
    return true;
  };
  if (signal?.aborted) halt();
  else signal?.addEventListener("abort", halt, { once: true });

  logger.info({ name }, `${name} started (${intervalMs}ms interval)`);

  return {
    stop: async () => {
      const first = halt();
      if (inFlight) {
        if (first) logger.info({ name }, `Waiting for in-flight ${name} batch to drain...`);
        await inFlight;
      }
      if (first) logger.info({ name }, `${name} stopped`);
    },
  };
}
