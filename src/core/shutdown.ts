import type { FastifyInstance } from "fastify";
import { logger } from "@shared/utils/logger.js";

const SHUTDOWN_TIMEOUT_MS = 30000; // 30 seconds max for graceful shutdown

// Cleanup responsibilities are registered via server.addHook('onClose') by their
// respective owners (prisma in server.ts, email queue in index.ts). This function
// only owns the signal handling and shutdown sequencing.
export function gracefulShutdown(server: FastifyInstance) {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  let isShuttingDown = false;

  signals.forEach((signal) => {
    process.on(signal, () => {
      // Prevent duplicate handling
      if (isShuttingDown) return;
      isShuttingDown = true;

      logger.info(`Received ${signal}, initiating graceful shutdown...`);

      // Force exit after timeout
      const forceExitTimer = setTimeout(() => {
        logger.error("Graceful shutdown timed out, forcing exit");
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);

      void (async () => {
        try {
          // server.close() stops accepting connections, drains in-flight requests,
          // then fires all onClose hooks (email queue + prisma) in registration order.
          await server.close();
          logger.info("HTTP server closed");

          clearTimeout(forceExitTimer);
          logger.info("Graceful shutdown complete");
          process.exit(0);
        } catch (error) {
          logger.error({ error }, "Error during graceful shutdown");
          clearTimeout(forceExitTimer);
          process.exit(1);
        }
      })();
    });
  });
}
