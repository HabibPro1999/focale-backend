import type { FastifyInstance } from "fastify";
import { prisma } from "@/database/client.js";
import { logger } from "@shared/utils/logger.js";

const SHUTDOWN_TIMEOUT_MS = 30000; // 30 seconds max for graceful shutdown

export function gracefulShutdown(
  server: FastifyInstance,
  emailQueueInterval?: ReturnType<typeof setInterval> | null,
  getActiveProcessing?: () => Promise<unknown> | null,
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
          // Stop email queue worker (no new iterations)
          if (emailQueueInterval) {
            clearInterval(emailQueueInterval);
            logger.info("Email queue worker stopped");
          }

          // Wait for in-flight email processing to complete
          const activePromise = getActiveProcessing?.();
          if (activePromise) {
            logger.info(
              "Waiting for in-flight email processing to complete...",
            );
            await Promise.race([
              activePromise,
              new Promise((resolve) => setTimeout(resolve, 10_000)), // 10s max wait
            ]);
            logger.info("In-flight email processing completed");
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
