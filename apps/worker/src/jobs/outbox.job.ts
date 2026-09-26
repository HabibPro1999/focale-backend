import { Injectable } from "@nestjs/common";
import { createLogger, makeWorkerId } from "@app/shared";
import {
  ACCESS_CAPACITY_REACHED_OUTBOX_TYPE,
  handleAccessCapacityReachedOutbox,
  NETWORKING_EVENT_SYNC_OUTBOX_TYPE,
  NETWORKING_REGISTRATION_SYNC_OUTBOX_TYPE,
  handleNetworkingEventSyncOutbox,
  handleNetworkingRegistrationSyncOutbox,
  processOutboxEvents,
  type OutboxHandlerRegistry,
  type OutboxHandlerResult,
  type TriggeredEmailOutboxPayload,
  type AbstractEmailOutboxPayload,
} from "@app/db";
import {
  queueTriggeredEmail,
  queueSponsorshipEmail,
  queueAbstractEmail,
  handleStorageDeleteOutbox,
  type QueueSponsorshipEmailInput,
} from "@app/integrations";
import type { AutomaticEmailTrigger } from "@app/contracts";
import type { Job, JobContext } from "../job";

const log = createLogger({ name: "worker:outbox" });

/** Rows claimed per batch; a run keeps claiming batches (see drainUntil). */
export const OUTBOX_BATCH_SIZE = 20;
/**
 * Budget kept after the drain window for the batch in flight: half the run.
 * A batch of 20 sequential handlers (email queueing, storage deletes,
 * networking syncs) normally takes about a second; if one still overruns,
 * the timeout signal releases its unstarted rows without an attempt penalty.
 */
export const OUTBOX_DRAIN_MARGIN_MS = 30_000;

interface SponsorshipEmailOutboxPayload {
  trigger: string;
  eventId: string;
  input: QueueSponsorshipEmailInput;
}

/**
 * Handler registry for the worker's outbox scope. Each type maps to an
 * integrations queue fn; those return false when no active template exists,
 * which we surface as "skipped" (terminal, no retry). Unknown types are NOT
 * registered — processOutboxEvents throws on them, routing to the normal
 * failure/retry/backoff path. The realtime types (`realtime.emit`,
 * `networking.notify`) are deliberately absent: they are scoped to the api
 * process, and with `scope: "background"` those rows are
 * never claimed here (with REALTIME_DISABLED none are written; the retention
 * job deletes realtime rows older than 24 h).
 */
export function buildOutboxHandlers(): OutboxHandlerRegistry {
  return {
    "email.triggered": async (payload): Promise<OutboxHandlerResult> => {
      const p = payload as TriggeredEmailOutboxPayload;
      const queued = await queueTriggeredEmail(
        p.trigger as AutomaticEmailTrigger,
        p.eventId,
        p.registration,
      );
      return queued ? "processed" : "skipped";
    },
    "email.sponsorship": async (payload): Promise<OutboxHandlerResult> => {
      const p = payload as SponsorshipEmailOutboxPayload;
      const queued = await queueSponsorshipEmail(
        p.trigger as AutomaticEmailTrigger,
        p.eventId,
        p.input,
      );
      return queued ? "processed" : "skipped";
    },
    "email.abstract": async (payload, meta): Promise<OutboxHandlerResult> => {
      // H6: the claimed outbox row's own id is the per-delivery idempotency
      // key — a crash-and-redeliver of this SAME row must not double-send.
      const queued = await queueAbstractEmail(
        payload as AbstractEmailOutboxPayload,
        meta.id,
      );
      return queued ? "processed" : "skipped";
    },
    "storage.delete": (payload) => handleStorageDeleteOutbox(payload),
    [ACCESS_CAPACITY_REACHED_OUTBOX_TYPE]: (payload, meta) => handleAccessCapacityReachedOutbox(payload, meta),
    [NETWORKING_REGISTRATION_SYNC_OUTBOX_TYPE]: (payload, meta) => handleNetworkingRegistrationSyncOutbox(payload, meta),
    [NETWORKING_EVENT_SYNC_OUTBOX_TYPE]: (payload, meta) => handleNetworkingEventSyncOutbox(payload, meta),
  };
}

@Injectable()
export class OutboxJob implements Job {
  readonly name = "outbox";
  readonly intervalMs = 5_000;
  readonly timeoutMs = 60_000;

  private readonly workerId = makeWorkerId("outbox");
  private readonly handlers = buildOutboxHandlers();

  async run({ signal, deadline }: JobContext): Promise<void> {
    // Drain: claim batches of 20 until the queue is empty or the drain window
    // (the run's budget minus the margin) ends; the next run starts 5 s later.
    // Only background rows: the api's realtime pump drains the realtime ones
    // on its own budget.
    const result = await processOutboxEvents(OUTBOX_BATCH_SIZE, {
      workerId: this.workerId,
      scope: "background",
      handlers: this.handlers,
      signal,
      drainUntil: deadline - OUTBOX_DRAIN_MARGIN_MS,
    });
    if (
      result.processed > 0 ||
      result.skipped > 0 ||
      result.failed > 0 ||
      result.leaseLost > 0 ||
      result.released > 0
    ) {
      log.info({ result }, "Outbox events processed");
    }
  }
}
