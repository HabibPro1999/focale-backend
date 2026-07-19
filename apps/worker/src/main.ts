import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { createLogger } from "@app/shared";
import { setEmailStatusChangeListener, emitEmailLogRealtimeEvent } from "@app/integrations";
import { WorkerModule } from "./worker.module";
import { JobRunner } from "./job-runner";
import { loadConfig } from "./core/config";

const log = createLogger({ name: "worker" });

process.on("unhandledRejection", (reason) => {
  log.error({ err: reason }, "Unhandled promise rejection");
  // Don't exit - let the application continue
});

async function bootstrap() {
  const config = loadConfig(); // fail-fast at boot

  // N3: emails can be queued/updated from either process — wire the same
  // listener here and in apps/api/src/main.ts so no email-log status change
  // is silently dropped depending on which process handled it.
  setEmailStatusChangeListener(emitEmailLogRealtimeEvent);

  if (!config.runWorkers) {
    log.info("RUN_WORKERS=false; in-process workers disabled");
    return;
  }

  const ctx = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  const runner = ctx.get(JobRunner);
  runner.start();
  log.info("worker started");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "worker shutting down");
    await runner.stop();
    await ctx.close();
    log.info("worker stopped");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

bootstrap().catch((err) => {
  log.error({ err }, "worker fatal boot error");
  process.exit(1);
});
