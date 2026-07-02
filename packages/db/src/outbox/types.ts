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

/** Realtime outbox rows carry an AppEvent as their payload. */
export type RealtimeOutboxPayload = AppEvent;

/** Which outbox rows a processor claims. Scope partitions api vs worker. */
export type OutboxProcessingScope = "all" | "realtime" | "background";

/** A handler's verdict. Anything else (or a throw) is a failure → retry. */
export type OutboxHandlerResult = "processed" | "skipped";

/** Per-type handler. Legacy `handleOutboxEvent` switch is now an injected map. */
export type OutboxHandler = (
  payload: unknown,
) => Promise<OutboxHandlerResult> | OutboxHandlerResult;

/** type → handler. The api process registers realtime.emit; the worker, email.* */
export type OutboxHandlerRegistry = Record<string, OutboxHandler>;
