import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  assertSchemaCurrent,
  closeDb,
  configureDb,
  pruneWorkerHeartbeats,
  recordWorkerHeartbeat,
} from "@app/db";
import { createLogger, makeWorkerId } from "@app/shared";
import {
  configureIntegrations,
  emitEmailLogRealtimeEvent,
  setEmailStatusChangeListener,
} from "@app/integrations";
import { WorkerModule } from "./worker.module";
import { JobRunner } from "./job-runner";
import { loadConfig } from "./core/config";
import { WorkerHeartbeat, createWorkerShutdown } from "./core/lifecycle";

const log = createLogger({ name: "worker" });

process.on("unhandledRejection", (reason) => {
  log.error({ err: reason }, "Unhandled promise rejection");
  // Don't exit - let the application continue
});

async function bootstrap() {
  // Parse the environment once (fail fast) and hand each package its slice.
  const config = loadConfig();
  configureDb({
    applicationName: "focale-worker",
    databaseUrl: config.DATABASE_URL,
    settings: config.database,
  });
  configureIntegrations(config.integrations);

  // N3: emails can be queued/updated from either process — wire the same
  // listener here and in apps/api/src/main.ts so no email-log status change
  // is silently dropped depending on which process handled it.
  setEmailStatusChangeListener(emitEmailLogRealtimeEvent);

  // One heartbeat, two outputs: the liveness file (image HEALTHCHECK) and this
  // process's worker_heartbeats row (/health/worker).
  const workerId = makeWorkerId("worker");
  const service = config.lifecycle.serviceName;
  const heartbeat = new WorkerHeartbeat({
    file: config.lifecycle.workerHeartbeatFile,
    logger: log,
    record: (state) => recordWorkerHeartbeat({ workerId, service, ...state }),
    prune: () => pruneWorkerHeartbeats(),
  });
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
  heartbeat.start({ disabled: false, jobs: () => runner.snapshot() });
  log.info({ workerId, service }, "worker started");

  // SIGTERM: stop scheduling, give running jobs until grace − 5 s, then abort
  // them through their signal; close the context and the pool; hard-exit at
  // SHUTDOWN_GRACE_MS.
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
