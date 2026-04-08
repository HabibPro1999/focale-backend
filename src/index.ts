import { buildServer } from "@core/server.js";
import { config } from "@config/app.config.js";
import { logger } from "@shared/utils/logger.js";
import { gracefulShutdown } from "@core/shutdown.js";
import { processEmailQueue } from "@modules/email/index.js";
import { prisma } from "@/database/client.js";

// Global error handlers
process.on("unhandledRejection", (reason, promise) => {
  logger.error({ reason, promise }, "Unhandled Promise Rejection");
  // Don't exit - let the application continue
});

process.on("uncaughtException", (error) => {
  logger.fatal({ error }, "Uncaught Exception - shutting down");
  process.exit(1);
});

// Retry until the database responds or we exhaust attempts.
// A fixed sleep is a guess; this actually verifies the connection.
// Linear backoff: 1s, 2s, 3s... up to maxRetries attempts (default max wait ~55s).
async function waitForDatabase(
  maxRetries = 10,
  baseDelayMs = 1000,
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      logger.info(`Database ready (attempt ${attempt})`);
      return;
    } catch (error) {
      if (attempt === maxRetries) {
        logger.fatal(
          { error },
          `Database unreachable after ${maxRetries} attempts`,
        );
        throw error;
      }
      const delay = baseDelayMs * attempt;
      logger.warn(
        `Database not ready (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function main() {
  const server = await buildServer();

  let emailQueueInterval: ReturnType<typeof setInterval> | undefined;
  let currentProcessing: Promise<void> | null = null;

  // Register hooks and shutdown BEFORE listen (Fastify disallows addHook after listen)
  server.addHook("onClose", async () => {
    if (emailQueueInterval) clearInterval(emailQueueInterval);
    if (currentProcessing) {
      logger.info("Waiting for in-flight email batch to complete...");
      await currentProcessing;
    }
    logger.info("Email queue worker stopped");
  });

  gracefulShutdown(server);

  // CRITICAL: Bind to port first, before any background tasks
  // This ensures Render detects the service as healthy
  await server.listen({ port: config.PORT, host: "0.0.0.0" });
  logger.info(`Server running on port ${config.PORT}`);

  // Verify the database is reachable before starting background workers
  await waitForDatabase();

  // Start email queue worker (processes every 15 seconds for faster email delivery)
  let isProcessingEmails = false;
  emailQueueInterval = setInterval(() => {
    if (isProcessingEmails) return;
    isProcessingEmails = true;
    currentProcessing = processEmailQueue(50)
      .then((result) => {
        if (result.processed > 0) {
          logger.info({ result }, "Email queue processed");
        }
      })
      .catch((err) => {
        logger.error({ err }, "Email queue processing failed");
      })
      .finally(() => {
        isProcessingEmails = false;
        currentProcessing = null;
      });
  }, 15_000);
  logger.info("Email queue worker started (15s interval)");
}

main().catch((err) => {
  logger.fatal(err, "Failed to start server");
  process.exit(1);
});
