import "reflect-metadata";
import { assertSchemaCurrent, closeDb, configureDb, configureOutbox } from "@app/db";
import {
  coalesceEmailStatusChanges,
  configureIntegrations,
  emitEmailLogRealtimeEvent,
  setEmailStatusChangeListener,
} from "@app/integrations";
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
  configureDb({
    applicationName: "focale-api",
    databaseUrl: config.DATABASE_URL,
    settings: config.database,
  });
  configureIntegrations(config.integrations);
  // REALTIME_DISABLED: realtime.emit rows are not written (nothing drains them).
  configureOutbox({ realtimeDisabled: config.realtime.disabled });

  // N3: emails can be queued/updated from either process — wire the same
  // listener here and in apps/worker/src/main.ts so no email-log status
  // change is silently dropped depending on which process handled it.
  // Coalesced per 250 ms (latest status per email log); flushed before the
  // pool closes. Not installed when realtime is disabled (nothing to emit).
  const emailStatus = coalesceEmailStatusChanges(emitEmailLogRealtimeEvent);
  if (!config.realtime.disabled) setEmailStatusChangeListener(emailStatus.listener);

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
