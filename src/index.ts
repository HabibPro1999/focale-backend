import { buildServer } from "@core/server.js";
import { config } from "@config/app.config.js";
import { logger } from "@shared/utils/logger.js";
import { gracefulShutdown } from "@core/shutdown.js";
import { startEmailWorker } from "@core/email-worker.js";

process.on("unhandledRejection", (reason, promise) => {
  logger.error({ reason, promise }, "Unhandled Promise Rejection");
});
process.on("uncaughtException", (error) => {
  logger.fatal({ error }, "Uncaught Exception - shutting down");
  process.exit(1);
});

async function main() {
  const server = await buildServer();
  let emailWorker: { stop(): Promise<void> } | null = null;
  server.addHook("preClose", async () => { await emailWorker?.stop(); });
  gracefulShutdown(server);
  await server.listen({ port: config.PORT, host: "0.0.0.0" });
  logger.info(`Server running on port ${config.PORT}`);
  await new Promise((resolve) => setTimeout(resolve, config.server.dbWarmupMs));
  emailWorker = startEmailWorker();
}

main().catch((err) => {
  logger.fatal(err, "Failed to start server");
  process.exit(1);
});
