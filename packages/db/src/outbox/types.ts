import type { AppEvent } from "@app/contracts";

export type OutboxEventStatus =
  | "PENDING"
  | "PROCESSING"
  | "PROCESSED"
  | "FAILED"
  | "DEAD_LETTERED"
  | "SKIPPED";

/** The realtime fan-out outbox type: `handleOutboxEvent` bridges it to the bus. */
export const REALTIME_EMIT_TYPE = "realtime.emit";

/** A networking participant notice (IDs only): the api pump signals its participant hub. */
export const NETWORKING_NOTIFY_TYPE = "networking.notify";

/**
 * Every outbox type the api's realtime pump drains (`scope: "realtime"`); the
 * worker's background scope and dead-letter requeue skip them, and retention
 * deletes them after 24 h.
 */
export const REALTIME_OUTBOX_TYPES: readonly string[] = [REALTIME_EMIT_TYPE, NETWORKING_NOTIFY_TYPE];

/** Realtime outbox rows carry an AppEvent as their payload. */
export type RealtimeOutboxPayload = AppEvent;

/** Which outbox rows a processor claims. Scope partitions api vs worker. */
export type OutboxProcessingScope = "all" | "realtime" | "background";

/** A handler's verdict. Anything else (or a throw) is a failure → retry. */
export type OutboxHandlerResult = "processed" | "skipped";

/**
 * Per-delivery metadata passed alongside the payload (H6). `id` is the claimed
 * outbox_events row's own id — stable across the retry/backoff lifecycle of a
 * single logical delivery, but a genuinely NEW outbox event (a legit re-trigger)
 * gets a new one. Handlers that need per-delivery idempotency (e.g.
 * queueAbstractEmail) thread it through as an email_logs dedupe key so a
 * crash-and-redeliver of the SAME row can't double-send.
 */
export interface OutboxHandlerMeta {
  id: string;
  /** Aborts on the job signal (timeout or shutdown) or when this row's lease is lost. */
  signal?: AbortSignal;
}

/** Per-type handler. Legacy `handleOutboxEvent` switch is now an injected map. */
export type OutboxHandler = (
  payload: unknown,
  meta: OutboxHandlerMeta,
) => Promise<OutboxHandlerResult> | OutboxHandlerResult;

/** type → handler. The api process registers realtime.emit; the worker, email.* */
export type OutboxHandlerRegistry = Record<string, OutboxHandler>;
