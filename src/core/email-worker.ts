import { config } from "@config/app.config.js";
import { logger } from "@shared/utils/logger.js";
import { processEmailQueue } from "@modules/email/index.js";

export function startEmailWorker(): { stop(): Promise<void> } {
  let activeProcessing: Promise<void> | null = null;

  const interval = setInterval(() => {
    if (activeProcessing) {
      logger.debug("Email queue processing already in progress, skipping");
      return;
    }

    activeProcessing = processEmailQueue(config.emailQueue.batchSize)
      .then((result) => {
        if (result.processed > 0) {
          logger.info({ result }, "Email queue processed");
        }
      })
      .catch((err) => {
        logger.error({ err }, "Email queue processing failed");
      })
      .finally(() => {
        activeProcessing = null;
      });
  }, config.emailQueue.intervalMs);

  logger.info("Email queue worker started (15s interval)");

  return {
    async stop(): Promise<void> {
      clearInterval(interval);
      logger.info("Email queue worker stopped");

      if (activeProcessing) {
        logger.info("Waiting for in-flight email processing to complete...");
        await Promise.race([
          activeProcessing,
          new Promise<void>((resolve) =>
            setTimeout(resolve, config.emailQueue.drainTimeoutMs),
          ),
        ]);
        logger.info("In-flight email processing completed");
      }
    },
  };
}
