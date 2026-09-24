import "reflect-metadata";
import { closeDb, configureDb } from "@app/db";
import { setEmailStatusChangeListener, emitEmailLogRealtimeEvent } from "@app/integrations";
import { buildApp } from "./app.factory";
import { loadConfig } from "./core/config";
import { logger } from "./core/logger.service";
import { createShutdownHandler } from "./core/shutdown";

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
  // Don't exit - let the application continue
});

async function bootstrap() {
  const config = loadConfig();
  configureDb({ applicationName: "focale-api" });

  // N3: emails can be queued/updated from either process — wire the same
  // listener here and in apps/worker/src/main.ts so no email-log status
  // change is silently dropped depending on which process handled it.
  setEmailStatusChangeListener(emitEmailLogRealtimeEvent);

  const app = await buildApp(config);

  // main.ts owns SIGTERM/SIGINT (buildApp does not enable Nest shutdown hooks,
  // which would close the app a second time): close the app, then the pool.
  const shutdown = createShutdownHandler({
    closeApp: () => app.close(),
    closeDb,
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
