import "reflect-metadata";
import { setEmailStatusChangeListener, emitEmailLogRealtimeEvent } from "@app/integrations";
import { buildApp } from "./app.factory";
import { loadConfig } from "./core/config";
import { logger } from "./core/logger.service";

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
  // Don't exit - let the application continue
});

async function bootstrap() {
  const config = loadConfig();

  // N3: emails can be queued/updated from either process — wire the same
  // listener here and in apps/worker/src/main.ts so no email-log status
  // change is silently dropped depending on which process handled it.
  setEmailStatusChangeListener(emitEmailLogRealtimeEvent);

  const app = await buildApp(config);
  await app.listen({ host: "0.0.0.0", port: config.PORT });
  logger.info({ port: config.PORT }, "API listening");
}

bootstrap().catch((err) => {
  logger.error({ err }, "Fatal boot error");
  process.exit(1);
});
