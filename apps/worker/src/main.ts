import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { assertSchemaCurrent, closeDb, configureDb } from "@app/db";
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
  configureDb({ applicationName: "focale-worker" });

  // N3: emails can be queued/updated from either process — wire the same
  // listener here and in apps/api/src/main.ts so no email-log status change
  // is silently dropped depending on which process handled it.
  setEmailStatusChangeListener(emitEmailLogRealtimeEvent);

  if (!config.runWorkers) {
    log.info("RUN_WORKERS=false; in-process workers disabled");
    return;
  }

  // MIGRATIONS_CHECK: enforce refuses to start on a stale schema; warn logs.
  await assertSchemaCurrent({ mode: config.MIGRATIONS_CHECK, logger: log });

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
    let exitCode = 0;
    try {
      await runner.stop();
      await ctx.close();
    } catch (err) {
      exitCode = 1;
      log.error({ err }, "worker shutdown failed");
    }
    try {
      await closeDb();
    } catch (err) {
      exitCode = 1;
      log.error({ err }, "database pool close failed");
    }
    log.info("worker stopped");
    process.exit(exitCode);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

bootstrap().catch((err) => {
  log.error({ err }, "worker fatal boot error");
  process.exit(1);
});
