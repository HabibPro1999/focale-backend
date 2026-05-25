import { logger } from "@shared/utils/logger.js";
import {
  disconnectWorkerDatabase,
  startWorkerRuntime,
  waitForDatabase,
} from "./worker-runtime.js";

const SHUTDOWN_TIMEOUT_MS = 30000; // 30 seconds max for graceful shutdown

process.on("unhandledRejection", (reason, promise) => {
  logger.error({ reason, promise }, "Unhandled Promise Rejection");
});

process.on("uncaughtException", (error) => {
  logger.fatal({ error }, "Uncaught Exception - shutting down");
  process.exit(1);
});

async function main() {
  await waitForDatabase();

  const workers = startWorkerRuntime();
  let isShuttingDown = false;

  const shutdown = (signal: NodeJS.Signals) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(`Received ${signal}, initiating worker shutdown...`);

    const forceExitTimer = setTimeout(() => {
      logger.error("Worker shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    void (async () => {
      try {
        await workers.stop();
        await disconnectWorkerDatabase();

        clearTimeout(forceExitTimer);
        logger.info("Worker shutdown complete");
        process.exit(0);
      } catch (error) {
        logger.error({ error }, "Error during worker shutdown");
        clearTimeout(forceExitTimer);
        process.exit(1);
      }
    })();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.fatal(err, "Failed to start workers");
  process.exit(1);
});
