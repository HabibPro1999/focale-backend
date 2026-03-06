import type { FastifyInstance } from "fastify";
import { logger } from "@shared/utils/logger.js";
import { config } from "@config/app.config.js";

export function gracefulShutdown(server: FastifyInstance): void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  let isShuttingDown = false;

  signals.forEach((signal) => {
    process.on(signal, () => {
      if (isShuttingDown) return;
      isShuttingDown = true;

      logger.info(`Received ${signal}, initiating graceful shutdown...`);

      const forceExitTimer = setTimeout(() => {
        logger.error("Graceful shutdown timed out, forcing exit");
        process.exit(1);
      }, config.shutdown.timeoutMs);

      server
        .close()
        .then(() => {
          clearTimeout(forceExitTimer);
          logger.info("Graceful shutdown complete");
          process.exit(0);
        })
        .catch((err) => {
          logger.error({ err }, "Shutdown failed");
          clearTimeout(forceExitTimer);
          process.exit(1);
        });
    });
  });
}
