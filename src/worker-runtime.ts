import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { prisma, getPool } from "@/database/client.js";
import { processAbstractBookJobs } from "@abstracts";
import { processOutboxEvents } from "@core/outbox";
import { processEmailQueue } from "@modules/email/index.js";
import { logger } from "@shared/utils/logger.js";
import { startPoller, type Poller } from "@shared/utils/poller.js";

type WorkerRuntime = {
  workerId: string;
  stop: () => Promise<void>;
};

// Retry until the database responds or we exhaust attempts.
// A fixed sleep is a guess; this actually verifies the connection.
// Linear backoff: 1s, 2s, 3s... up to maxRetries attempts (default max wait ~55s).
export async function waitForDatabase(
  maxRetries = 10,
  baseDelayMs = 1000,
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      logger.info(`Database ready (attempt ${attempt})`);
      return;
    } catch (error) {
      if (attempt === maxRetries) {
        logger.fatal(
          { error },
          `Database unreachable after ${maxRetries} attempts`,
        );
        throw error;
      }
      const delay = baseDelayMs * attempt;
      logger.warn(
        `Database not ready (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export function shouldRunWorkers(): boolean {
  return process.env.RUN_WORKERS !== "false";
}

export function startWorkerRuntime(): WorkerRuntime {
  const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;

  // Start outbox worker first: it turns durable non-realtime domain events into
  // queue rows. Realtime events are consumed by the web process that owns SSE.
  const outboxPoller: Poller = startPoller({
    name: "Outbox worker",
    intervalMs: 5_000,
    work: async () => {
      const result = await processOutboxEvents(50, {
        workerId,
        scope: "background",
      });
      if (
        result.processed > 0 ||
        result.skipped > 0 ||
        result.failed > 0 ||
        result.leaseLost > 0
      ) {
        logger.info({ result }, "Outbox events processed");
      }
    },
  });

  const emailPoller: Poller = startPoller({
    name: "Email queue worker",
    intervalMs: 15_000,
    work: async () => {
      const result = await processEmailQueue(50, { workerId });
      if (result.processed > 0) {
        logger.info({ result }, "Email queue processed");
      }
    },
  });

  const bookPoller: Poller = startPoller({
    name: "Abstract Book worker",
    intervalMs: 30_000,
    work: async () => {
      const result = await processAbstractBookJobs(1, { workerId });
      if (result.processed > 0) {
        logger.info({ result }, "Abstract Book jobs processed");
      }
    },
  });

  return {
    workerId,
    stop: async () => {
      await Promise.all([
        outboxPoller.stop(),
        emailPoller.stop(),
        bookPoller.stop(),
      ]);
    },
  };
}

export async function disconnectWorkerDatabase(): Promise<void> {
  try {
    await prisma.$disconnect();
  } catch (err) {
    logger.error({ err }, "Error disconnecting Prisma");
  }
  const pool = getPool();
  if (pool) {
    try {
      await pool.end();
    } catch (err) {
      logger.error({ err }, "Error draining connection pool");
    }
  }
  logger.info("Database disconnected");
}
