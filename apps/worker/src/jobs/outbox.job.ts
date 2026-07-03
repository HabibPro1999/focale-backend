import { Injectable } from "@nestjs/common";
import { createLogger, makeWorkerId } from "@app/shared";
import {
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
  type QueueSponsorshipEmailInput,
} from "@app/integrations";
import type { AutomaticEmailTrigger } from "@app/contracts";
import type { Job } from "../job";

const log = createLogger({ name: "worker:outbox" });

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
 * failure/retry/backoff path. `realtime.emit` is deliberately absent: it is
 * scoped to the api process, and with `scope: "background"` those rows are
 * never claimed here (they pile up if realtime is disabled — legacy parity).
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
    "email.abstract": async (payload): Promise<OutboxHandlerResult> => {
      const queued = await queueAbstractEmail(
        payload as AbstractEmailOutboxPayload,
      );
      return queued ? "processed" : "skipped";
    },
  };
}

@Injectable()
export class OutboxJob implements Job {
  readonly name = "outbox";
  readonly intervalMs = 5_000;

  private readonly workerId = makeWorkerId("outbox");
  private readonly handlers = buildOutboxHandlers();

  async run(): Promise<void> {
    const result = await processOutboxEvents(50, {
      workerId: this.workerId,
      scope: "background",
      handlers: this.handlers,
    });
    if (
      result.processed > 0 ||
      result.skipped > 0 ||
      result.failed > 0 ||
      result.leaseLost > 0
    ) {
      log.info({ result }, "Outbox events processed");
    }
  }
}
