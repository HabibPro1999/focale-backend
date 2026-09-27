import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { assertSchemaCurrent, closeDb } from "@app/db";
import { createLogger } from "@app/shared";
import { configureRuntime, registerUnhandledRejectionLogger } from "@app/integrations";
import { WorkerModule } from "./worker.module";
import { JobRunner } from "./job-runner";
import { parseAppConfig } from "@app/contracts";
import { WorkerHeartbeat, createWorkerShutdown } from "./core/lifecycle";

const log = createLogger({ name: "worker" });

registerUnhandledRejectionLogger(log);

async function bootstrap() {
  // Parse the environment once (fail fast) and hand each package its slice.
  const config = parseAppConfig(process.env);
  configureRuntime(config, "focale-worker");

  const heartbeat = new WorkerHeartbeat(config.lifecycle.workerHeartbeatFile, log);
  const onSignals = (shutdown: (signal: string) => Promise<void>) => {
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
  };

  if (!config.runWorkers) {
    // Idle instead of exiting: an exited worker ends (or restarts) its container.
    log.info("RUN_WORKERS=false; jobs disabled, worker idling with a disabled heartbeat");
    heartbeat.start({ disabled: true });
    onSignals(
      createWorkerShutdown({
        graceMs: config.lifecycle.shutdownGraceMs,
        closeDb,
        heartbeat,
        exit: (code) => process.exit(code),
        logger: log,
      }),
    );
    return;
  }

  // MIGRATIONS_CHECK: enforce refuses to start on a stale schema; warn logs.
  await assertSchemaCurrent({ mode: config.MIGRATIONS_CHECK, logger: log });

  const ctx = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  const runner = ctx.get(JobRunner);
  runner.start();
  heartbeat.start({ disabled: false });
  log.info("worker started");

  // SIGTERM: stop scheduling, give running jobs until grace − 5 s, close the
  // context and the pool, hard-exit at SHUTDOWN_GRACE_MS.
  onSignals(
    createWorkerShutdown({
      graceMs: config.lifecycle.shutdownGraceMs,
      stopRunner: (deadline) => runner.stop({ deadline }),
      closeContext: () => ctx.close(),
      closeDb,
      heartbeat,
      exit: (code) => process.exit(code),
      logger: log,
    }),
  );
}

bootstrap().catch((err) => {
  log.error({ err }, "worker fatal boot error");
  process.exit(1);
});
