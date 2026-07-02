import { createLogger } from "./logger";

const logger = createLogger({ name: "poller" });

export interface PollerOptions {
  name: string;
  intervalMs: number;
  work: () => Promise<void>;
}

export interface Poller {
  stop: () => Promise<void>;
}

/**
 * setInterval loop with overlap protection: a tick is skipped while a previous
 * `work()` is still in flight. Errors are caught+logged (never crash the loop).
 * First run happens after the first `intervalMs`, not immediately. `stop()` is
 * idempotent, clears the interval, and awaits any in-flight run before returning.
 * Ported from the legacy `src/shared/utils/poller.ts`.
 */
export function startPoller({ name, intervalMs, work }: PollerOptions): Poller {
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

  logger.info({ name }, `${name} started (${intervalMs}ms interval)`);

  return {
    stop: async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      if (inFlight) {
        logger.info(
          { name },
          `Waiting for in-flight ${name} batch to drain...`,
        );
        await inFlight;
      }
      logger.info({ name }, `${name} stopped`);
    },
  };
}
