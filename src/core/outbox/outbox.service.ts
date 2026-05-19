import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { prisma } from "@/database/client.js";
import { Prisma } from "@/generated/prisma/client.js";
import { logger } from "@shared/utils/logger.js";
import { getPrismaUniqueTarget } from "@shared/errors/prisma-error.js";
import { handleOutboxEvent } from "./handlers.js";
import {
  REALTIME_EMIT_TYPE,
  type OutboxEventType,
  type OutboxPayloadByType,
  type OutboxEventStatus,
  type RealtimeOutboxPayload,
} from "./types.js";

const OUTBOX_LEASE_MS = 5 * 60 * 1000;
const OUTBOX_UNHEALTHY_AGE_MS = 10 * 60 * 1000;
const OUTBOX_UNHEALTHY_SIZE = 1000;
const OUTBOX_RECOVERY_INTERVAL_MS = 60 * 1000;
const DEFAULT_WORKER_ID = `outbox:${hostname()}:${process.pid}:${randomUUID()}`;

let lastRecoveryAt = 0;

export type OutboxClient = {
  outboxEvent: Pick<typeof prisma.outboxEvent, "create">;
};

export interface EnqueueOutboxInput<T extends OutboxEventType> {
  type: T;
  payload: OutboxPayloadByType[T];
  aggregateType?: string;
  aggregateId?: string;
  clientId?: string;
  eventId?: string;
  dedupeKey?: string;
  maxAttempts?: number;
}

export interface ProcessOutboxOptions {
  workerId?: string;
  leaseMs?: number;
  scope?: OutboxProcessingScope;
}

export type OutboxProcessingScope = "all" | "realtime" | "background";

export interface ProcessOutboxResult {
  processed: number;
  skipped: number;
  failed: number;
  leaseLost: number;
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function outboxRetryDelayMs(attemptCount: number): number {
  if (attemptCount <= 1) return 30 * 1000;
  if (attemptCount === 2) return 2 * 60 * 1000;
  if (attemptCount === 3) return 5 * 60 * 1000;
  return 15 * 60 * 1000;
}

function nextOutboxAttemptAt(attemptCount: number, from = new Date()): Date {
  return new Date(from.getTime() + outboxRetryDelayMs(attemptCount));
}

function clearOutboxLeaseFields() {
  return {
    lockedAt: null,
    lockedUntil: null,
    lockedBy: null,
  };
}

function outboxScopeClause(scope: OutboxProcessingScope): string {
  if (scope === "realtime") return `AND "type" = '${REALTIME_EMIT_TYPE}'`;
  if (scope === "background") return `AND "type" <> '${REALTIME_EMIT_TYPE}'`;
  return "";
}

function isOutboxDedupeViolation(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }

  const { fields, names } = getPrismaUniqueTarget(error);
  return (
    fields.some((field) => field === "dedupeKey" || field === "dedupe_key") ||
    names.some((name) => name.includes("outbox_events_dedupe_key_key"))
  );
}

export async function enqueueOutboxEvent<T extends OutboxEventType>(
  client: OutboxClient,
  input: EnqueueOutboxInput<T>,
): Promise<boolean> {
  try {
    const outboxEvent = client.outboxEvent ?? prisma.outboxEvent;
    await outboxEvent.create({
      data: {
        type: input.type,
        aggregateType: input.aggregateType ?? null,
        aggregateId: input.aggregateId ?? null,
        clientId: input.clientId ?? null,
        eventId: input.eventId ?? null,
        dedupeKey: input.dedupeKey ?? null,
        payload: toJsonValue(input.payload),
        maxAttempts: input.maxAttempts ?? 5,
      },
    });
    return true;
  } catch (error) {
    if (isOutboxDedupeViolation(error)) {
      logger.info(
        { type: input.type, dedupeKey: input.dedupeKey },
        "Outbox event already enqueued, skipping duplicate",
      );
      return false;
    }
    throw error;
  }
}

export async function enqueueRealtimeOutboxEvent(
  client: OutboxClient,
  payload: RealtimeOutboxPayload,
  dedupeKey?: string,
): Promise<boolean> {
  return enqueueOutboxEvent(client, {
    type: REALTIME_EMIT_TYPE,
    payload,
    aggregateType: payload.type,
    aggregateId: String(payload.payload.id),
    clientId: payload.clientId,
    eventId: payload.eventId,
    dedupeKey,
    maxAttempts: 10,
  });
}

export async function enqueueTriggeredEmailOutboxEvent(
  client: OutboxClient,
  payload: OutboxPayloadByType["email.triggered"],
  dedupeKey?: string,
): Promise<boolean> {
  return enqueueOutboxEvent(client, {
    type: "email.triggered",
    payload,
    aggregateType: "Registration",
    aggregateId: payload.registration.id,
    eventId: payload.eventId,
    dedupeKey,
  });
}

export async function enqueueAbstractEmailOutboxEvent(
  client: OutboxClient,
  payload: OutboxPayloadByType["email.abstract"],
  dedupeKey?: string,
): Promise<boolean> {
  return enqueueOutboxEvent(client, {
    type: "email.abstract",
    payload,
    aggregateType: "Abstract",
    aggregateId: payload.abstractId,
    dedupeKey,
  });
}

export async function enqueueSponsorshipEmailOutboxEvent(
  client: OutboxClient,
  payload: OutboxPayloadByType["email.sponsorship"],
  dedupeKey?: string,
): Promise<boolean> {
  return enqueueOutboxEvent(client, {
    type: "email.sponsorship",
    payload,
    aggregateType: "Registration",
    aggregateId: payload.input.registrationId,
    eventId: payload.eventId,
    dedupeKey,
  });
}

export async function recoverStaleOutboxLeases(
  now = new Date(),
): Promise<{ requeued: number; deadLettered: number }> {
  const requeued = await prisma.$executeRaw`
    UPDATE "outbox_events"
    SET
      "status" = 'FAILED',
      "next_attempt_at" = ${now},
      "locked_at" = NULL,
      "locked_until" = NULL,
      "locked_by" = NULL
    WHERE "status" = 'PROCESSING'
      AND "locked_until" < ${now}
      AND "attempt_count" < "max_attempts"
  `;

  const deadLettered = await prisma.$executeRaw`
    UPDATE "outbox_events"
    SET
      "status" = 'DEAD_LETTERED',
      "next_attempt_at" = NULL,
      "locked_at" = NULL,
      "locked_until" = NULL,
      "locked_by" = NULL
    WHERE "status" = 'PROCESSING'
      AND "locked_until" < ${now}
      AND "attempt_count" >= "max_attempts"
  `;

  if (requeued > 0 || deadLettered > 0) {
    logger.warn(
      { requeued, deadLettered },
      "Recovered stale outbox leases",
    );
  }

  return { requeued, deadLettered };
}

async function markOutboxProcessed(
  id: string,
  status: Extract<OutboxEventStatus, "PROCESSED" | "SKIPPED">,
  workerId: string,
): Promise<boolean> {
  const now = new Date();
  const updated = await prisma.outboxEvent.updateMany({
    where: {
      id,
      status: "PROCESSING",
      lockedBy: workerId,
    },
    data: {
      status,
      processedAt: now,
      errorMessage: null,
      nextAttemptAt: null,
      ...clearOutboxLeaseFields(),
    },
  });
  return updated.count > 0;
}

async function markOutboxFailed(
  id: string,
  workerId: string,
  attemptCount: number,
  maxAttempts: number,
  error: unknown,
): Promise<boolean> {
  const now = new Date();
  const shouldDeadLetter = attemptCount >= maxAttempts;
  const updated = await prisma.outboxEvent.updateMany({
    where: {
      id,
      status: "PROCESSING",
      lockedBy: workerId,
    },
    data: {
      status: shouldDeadLetter ? "DEAD_LETTERED" : "FAILED",
      errorMessage: error instanceof Error ? error.message : String(error),
      lastAttemptAt: now,
      nextAttemptAt: shouldDeadLetter
        ? null
        : nextOutboxAttemptAt(attemptCount, now),
      ...clearOutboxLeaseFields(),
    },
  });
  return updated.count > 0;
}

function startOutboxLeaseRenewal(
  id: string,
  workerId: string,
  leaseMs: number,
): () => void {
  const renewEveryMs = Math.max(1_000, Math.floor(leaseMs / 2));
  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    const now = new Date();
    void prisma.outboxEvent
      .updateMany({
        where: {
          id,
          status: "PROCESSING",
          lockedBy: workerId,
        },
        data: {
          lockedUntil: new Date(now.getTime() + leaseMs),
        },
      })
      .catch((err: unknown) => {
        logger.warn({ err, outboxEventId: id }, "Outbox lease renewal failed");
      });
  }, renewEveryMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

function recordLeaseLost(
  result: ProcessOutboxResult,
  id: string,
  workerId: string,
  status: OutboxEventStatus,
): void {
  result.leaseLost++;
  logger.warn(
    { outboxEventId: id, workerId, status },
    "Outbox event lease was lost before status update",
  );
}

export async function processOutboxEvents(
  batchSize = 50,
  options: ProcessOutboxOptions = {},
): Promise<ProcessOutboxResult> {
  const result = { processed: 0, skipped: 0, failed: 0, leaseLost: 0 };
  const workerId = options.workerId ?? DEFAULT_WORKER_ID;
  const leaseMs = options.leaseMs ?? OUTBOX_LEASE_MS;
  const scope = options.scope ?? "all";
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + leaseMs);
  const scopeClause = outboxScopeClause(scope);

  if (now.getTime() - lastRecoveryAt >= OUTBOX_RECOVERY_INTERVAL_MS) {
    lastRecoveryAt = now.getTime();
    await recoverStaleOutboxLeases(now);
  }

  const claimedRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE "outbox_events"
     SET
       "status" = 'PROCESSING',
       "updated_at" = $1,
       "locked_at" = $1,
       "locked_until" = $2,
       "locked_by" = $3,
       "last_attempt_at" = $1,
       "attempt_count" = "attempt_count" + 1,
       "error_message" = NULL
     WHERE "id" IN (
       SELECT "id" FROM "outbox_events"
        WHERE "status" IN ('PENDING', 'FAILED')
          AND ("next_attempt_at" IS NULL OR "next_attempt_at" <= $1)
          AND "attempt_count" < "max_attempts"
          ${scopeClause}
        ORDER BY "created_at" ASC
        LIMIT $4
        FOR UPDATE SKIP LOCKED
     )
     RETURNING "id"`,
    now,
    lockedUntil,
    workerId,
    batchSize,
  );

  const ids = claimedRows.map((row) => row.id);
  if (ids.length === 0) return result;

  const events = await prisma.outboxEvent.findMany({
    where: { id: { in: ids }, status: "PROCESSING", lockedBy: workerId },
    orderBy: { createdAt: "asc" },
  });

  for (const event of events) {
    const stopRenewal = startOutboxLeaseRenewal(event.id, workerId, leaseMs);
    try {
      const outcome = await handleOutboxEvent(event.type, event.payload);
      if (outcome === "skipped") {
        const marked = await markOutboxProcessed(event.id, "SKIPPED", workerId);
        if (marked) result.skipped++;
        else recordLeaseLost(result, event.id, workerId, "SKIPPED");
      } else {
        const marked = await markOutboxProcessed(
          event.id,
          "PROCESSED",
          workerId,
        );
        if (marked) result.processed++;
        else recordLeaseLost(result, event.id, workerId, "PROCESSED");
      }
    } catch (error) {
      logger.error(
        { err: error, outboxEventId: event.id, type: event.type },
        "Outbox event processing failed",
      );
      const marked = await markOutboxFailed(
        event.id,
        workerId,
        event.attemptCount,
        event.maxAttempts,
        error,
      );
      if (marked) result.failed++;
      else recordLeaseLost(result, event.id, workerId, "FAILED");
    } finally {
      stopRenewal();
    }
  }

  return result;
}

export async function getOutboxHealth() {
  const now = new Date();
  const [
    pending,
    failed,
    processing,
    deadLettered,
    oldestPending,
    oldestProcessing,
  ] = await Promise.all([
    prisma.outboxEvent.count({ where: { status: "PENDING" } }),
    prisma.outboxEvent.count({ where: { status: "FAILED" } }),
    prisma.outboxEvent.count({ where: { status: "PROCESSING" } }),
    prisma.outboxEvent.count({ where: { status: "DEAD_LETTERED" } }),
    prisma.outboxEvent.findFirst({
      where: { status: { in: ["PENDING", "FAILED"] } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    prisma.outboxEvent.findFirst({
      where: { status: "PROCESSING" },
      orderBy: [{ lockedAt: "asc" }, { updatedAt: "asc" }],
      select: { lockedAt: true, updatedAt: true },
    }),
  ]);

  const oldestPendingAgeMs = oldestPending
    ? now.getTime() - oldestPending.createdAt.getTime()
    : 0;
  const oldestProcessingAt =
    oldestProcessing?.lockedAt ?? oldestProcessing?.updatedAt;
  const oldestProcessingAgeMs = oldestProcessingAt
    ? now.getTime() - oldestProcessingAt.getTime()
    : 0;
  const isHealthy =
    deadLettered === 0 &&
    pending + failed < OUTBOX_UNHEALTHY_SIZE &&
    oldestPendingAgeMs < OUTBOX_UNHEALTHY_AGE_MS &&
    oldestProcessingAgeMs < OUTBOX_LEASE_MS * 2;

  return {
    isHealthy,
    counts: { pending, failed, processing, deadLettered },
    oldestPendingAgeMs,
    oldestProcessingAgeMs,
  };
}
