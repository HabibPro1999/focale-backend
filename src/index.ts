import { buildServer } from "@core/server.js";
import { config } from "@config/app.config.js";
import { logger } from "@shared/utils/logger.js";
import { gracefulShutdown } from "@core/shutdown.js";
import { startRealtimeOutboxPump } from "@core/outbox";
import {
  shouldRunWorkers,
  startWorkerRuntime,
  waitForDatabase,
} from "./worker-runtime.js";

// Global error handlers
process.on("unhandledRejection", (reason, promise) => {
  logger.error({ reason, promise }, "Unhandled Promise Rejection");
  // Don't exit - let the application continue
});

process.on("uncaughtException", (error) => {
  logger.fatal({ error }, "Uncaught Exception - shutting down");
  process.exit(1);
});

async function main() {
  const server = await buildServer();
  let workers: ReturnType<typeof startWorkerRuntime> | undefined;
  let realtimePump: ReturnType<typeof startRealtimeOutboxPump> | undefined;
  let databaseReady = false;

  const ensureDatabaseReady = async () => {
    if (databaseReady) return;
    await waitForDatabase();
    databaseReady = true;
  };

  // Register hooks and shutdown BEFORE listen (Fastify disallows addHook after listen)
  server.addHook("onClose", async () => {
    await realtimePump?.stop();
    await workers?.stop();
  });

  gracefulShutdown(server);

  // CRITICAL: Bind to port first, before any background tasks
  // This ensures Render detects the service as healthy
  await server.listen({ port: config.PORT, host: "0.0.0.0" });
  logger.info(`Server running on port ${config.PORT}`);

  if (!config.realtime.disabled) {
    await ensureDatabaseReady();
    realtimePump = startRealtimeOutboxPump();
  } else {
    logger.info("Realtime disabled; realtime outbox pump not started");
  }

  if (shouldRunWorkers()) {
    // Verify the database is reachable before starting background workers
    await ensureDatabaseReady();
    workers = startWorkerRuntime();
  } else {
    logger.info("RUN_WORKERS=false; in-process workers disabled");
  }
}

main().catch((err) => {
  logger.fatal(err, "Failed to start server");
  process.exit(1);
});
