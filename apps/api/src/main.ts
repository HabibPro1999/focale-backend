import "reflect-metadata";
import { assertSchemaCurrent, closeDb } from "@app/db";
import { configureRuntime } from "@app/integrations";
import { buildApp } from "./app.factory";
import { loadConfig } from "./core/config";
import { logger } from "./core/logger.service";
import { ShutdownCoordinator, createShutdownHandler } from "./core/shutdown";
import { ReadinessService } from "./modules/health/readiness.service";

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
  // Don't exit - let the application continue
});

async function bootstrap() {
  // Parse the environment once (fail fast) and hand each package its slice.
  const config = loadConfig();
  const emailStatus = configureRuntime(config, "focale-api");

  // MIGRATIONS_CHECK: enforce refuses to start on a stale schema; warn logs
  // (and /health/ready reports it).
  const schemaCheck = await assertSchemaCurrent({ mode: config.MIGRATIONS_CHECK, logger });

  const app = await buildApp(config);
  app.get(ReadinessService).recordSchemaCheck(schemaCheck);

  // main.ts owns SIGTERM/SIGINT (buildApp does not enable Nest shutdown hooks,
  // which would close the app a second time): drain, close the app, then the
  // pool, all within SHUTDOWN_GRACE_MS (see core/shutdown.ts).
  const coordinator = app.get(ShutdownCoordinator);
  const shutdown = createShutdownHandler({
    graceMs: config.lifecycle.shutdownGraceMs,
    startDraining: () => coordinator.startDraining(),
    closeApp: () => app.close(),
    forceCloseConnections: () => app.getHttpServer().closeAllConnections(),
    closeDb: async () => {
      await emailStatus.flush();
      await closeDb();
    },
    exit: (code) => process.exit(code),
    logger,
  });
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: "0.0.0.0", port: config.PORT });
  logger.info({ port: config.PORT }, "API listening");
}

bootstrap().catch((err) => {
  logger.error({ err }, "Fatal boot error");
  process.exit(1);
});
