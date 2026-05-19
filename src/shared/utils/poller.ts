import { logger } from "@shared/utils/logger.js";

export interface PollerOptions {
  name: string;
  intervalMs: number;
  work: () => Promise<void>;
}

export interface Poller {
  stop: () => Promise<void>;
}

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
        logger.info({ name }, `Waiting for in-flight ${name} batch to drain...`);
        await inFlight;
      }
      logger.info({ name }, `${name} stopped`);
    },
  };
}
