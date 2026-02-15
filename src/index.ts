import { buildServer } from "@core/server.js";
import { config } from "@config/app.config.js";
import { logger } from "@shared/utils/logger.js";
import { gracefulShutdown } from "@core/shutdown.js";
import { processEmailQueue } from "@modules/email/index.js";
import { sendAlert } from "@shared/utils/alerter.js";

// Global error handlers
process.on("unhandledRejection", (reason, promise) => {
  logger.error({ reason, promise }, "Unhandled Promise Rejection");
  sendAlert({
    title: "Unhandled Rejection",
    message: String(reason),
    severity: "critical",
  });
  // Don't exit - let the application continue
});

process.on("uncaughtException", (error) => {
  logger.fatal({ error }, "Uncaught Exception - shutting down");
  process.exit(1);
});

async function main() {
  const server = await buildServer();

  // CRITICAL: Bind to port first, before any background tasks
  // This ensures Render detects the service as healthy
  await server.listen({ port: config.PORT, host: "0.0.0.0" });
  logger.info(`Server running on port ${config.PORT}`);

  // Wait for database to wake up (common on Render with hibernating databases)
  const dbWarmupDelay = config.isProduction ? 5000 : 1000;
  logger.info(`Waiting ${dbWarmupDelay}ms for database warmup...`);
  await new Promise((resolve) => setTimeout(resolve, dbWarmupDelay));

  // Start email queue worker (processes every 15 seconds for faster email delivery)
  // Track active processing to prevent overlaps and enable graceful shutdown
  let activeProcessing: Promise<void> | null = null;

  const emailQueueInterval = setInterval(() => {
    // Don't start new processing if one is still running
    if (activeProcessing) {
      logger.debug("Email queue processing already in progress, skipping");
      return;
    }

    activeProcessing = processEmailQueue(50)
      .then((result) => {
        if (result.processed > 0) {
          logger.info({ result }, "Email queue processed");
        }
      })
      .catch((err) => {
        // Non-fatal: log error but keep server running
        logger.error({ err }, "Email queue processing failed");
        sendAlert({
          title: "Email Queue Error",
          message: err.message,
          severity: "error",
        });
      })
      .finally(() => {
        activeProcessing = null;
      });
  }, 15_000);
  logger.info("Email queue worker started (15s interval)");

  gracefulShutdown(server, emailQueueInterval, () => activeProcessing);
}

main().catch((err) => {
  logger.fatal(err, "Failed to start server");
  process.exit(1);
});
