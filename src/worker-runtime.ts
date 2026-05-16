import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { prisma, getPool } from "@/database/client.js";
import { processAbstractBookJobs } from "@abstracts";
import { processOutboxEvents } from "@core/outbox";
import { processEmailQueue } from "@modules/email/index.js";
import { logger } from "@shared/utils/logger.js";

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

  let currentProcessing: Promise<void> | null = null;
  let currentBookProcessing: Promise<void> | null = null;
  let currentOutboxProcessing: Promise<void> | null = null;
  let isStopping = false;
  let isProcessingEmails = false;
  let isProcessingBookJobs = false;
  let isProcessingOutbox = false;

  // Start outbox worker first: it turns durable domain events into queue rows
  // and realtime notifications.
  const outboxInterval = setInterval(() => {
    if (isStopping || isProcessingOutbox) return;
    isProcessingOutbox = true;
    currentOutboxProcessing = processOutboxEvents(50, { workerId })
      .then((result) => {
        if (result.processed > 0 || result.skipped > 0 || result.failed > 0) {
          logger.info({ result }, "Outbox events processed");
        }
      })
      .catch((err) => {
        logger.error({ err }, "Outbox event processing failed");
      })
      .finally(() => {
        isProcessingOutbox = false;
        currentOutboxProcessing = null;
      });
  }, 5_000);
  logger.info({ workerId }, "Outbox worker started (5s interval)");

  // Start email queue worker (processes every 15 seconds for faster email delivery)
  const emailQueueInterval = setInterval(() => {
    if (isStopping || isProcessingEmails) return;
    isProcessingEmails = true;
    currentProcessing = processEmailQueue(50, { workerId })
      .then((result) => {
        if (result.processed > 0) {
          logger.info({ result }, "Email queue processed");
        }
      })
      .catch((err) => {
        logger.error({ err }, "Email queue processing failed");
      })
      .finally(() => {
        isProcessingEmails = false;
        currentProcessing = null;
      });
  }, 15_000);
  logger.info({ workerId }, "Email queue worker started (15s interval)");

  // Start Abstract Book worker (processes one generation job every 30 seconds)
  const bookJobInterval = setInterval(() => {
    if (isStopping || isProcessingBookJobs) return;
    isProcessingBookJobs = true;
    currentBookProcessing = processAbstractBookJobs(1, { workerId })
      .then((result) => {
        if (result.processed > 0) {
          logger.info({ result }, "Abstract Book jobs processed");
        }
      })
      .catch((err) => {
        logger.error({ err }, "Abstract Book job processing failed");
      })
      .finally(() => {
        isProcessingBookJobs = false;
        currentBookProcessing = null;
      });
  }, 30_000);
  logger.info({ workerId }, "Abstract Book worker started (30s interval)");

  return {
    workerId,
    stop: async () => {
      if (isStopping) return;
      isStopping = true;

      clearInterval(outboxInterval);
      clearInterval(emailQueueInterval);
      clearInterval(bookJobInterval);
      if (currentOutboxProcessing) {
        logger.info("Waiting for in-flight outbox batch to complete...");
        await currentOutboxProcessing;
      }
      logger.info("Outbox worker stopped");
      if (currentProcessing) {
        logger.info("Waiting for in-flight email batch to complete...");
        await currentProcessing;
      }
      logger.info("Email queue worker stopped");
      if (currentBookProcessing) {
        logger.info("Waiting for in-flight Abstract Book job to complete...");
        await currentBookProcessing;
      }
      logger.info("Abstract Book worker stopped");
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
