import type { FastifyInstance } from "fastify";
import { prisma } from "@/database/client.js";
import { logger } from "@shared/utils/logger.js";

const SHUTDOWN_TIMEOUT_MS = 30000; // 30 seconds max for graceful shutdown

export function gracefulShutdown(
  server: FastifyInstance,
  cleanupHooks: Array<() => Promise<void>> = [],
) {
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
          // Run cleanup hooks
          for (const hook of cleanupHooks) {
            await hook();
          }

          // Stop accepting new connections
          await server.close();
          logger.info("HTTP server closed");

          // Disconnect database
          await prisma.$disconnect();
          logger.info("Database disconnected");

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
