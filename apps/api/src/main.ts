import "reflect-metadata";
import { buildApp } from "./app.factory";
import { loadConfig } from "./core/config";
import { logger } from "./core/logger.service";

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
  // Don't exit - let the application continue
});

async function bootstrap() {
  const config = loadConfig();
  const app = await buildApp(config);
  await app.listen({ host: "0.0.0.0", port: config.PORT });
  logger.info({ port: config.PORT }, "API listening");
}

bootstrap().catch((err) => {
  logger.error({ err }, "Fatal boot error");
  process.exit(1);
});
