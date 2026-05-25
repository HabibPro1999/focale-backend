import { eventBus } from "@core/events/bus.js";
import { queueTriggeredEmail, queueSponsorshipEmail } from "@email";
import { queueAbstractEmail } from "@modules/abstracts/abstracts.email-queue.js";
import type {
  AbstractEmailPayload,
  OutboxEventType,
  RealtimeOutboxPayload,
  SponsorshipEmailPayload,
  TriggeredEmailPayload,
} from "./types.js";
import { REALTIME_EMIT_TYPE } from "./types.js";

export type OutboxHandlerResult = "processed" | "skipped";

export async function handleOutboxEvent(
  type: string,
  payload: unknown,
): Promise<OutboxHandlerResult> {
  switch (type as OutboxEventType) {
    case REALTIME_EMIT_TYPE:
      eventBus.emit(payload as RealtimeOutboxPayload);
      return "processed";

    case "email.triggered": {
      const input = payload as TriggeredEmailPayload;
      const queued = await queueTriggeredEmail(
        input.trigger,
        input.eventId,
        input.registration,
      );
      return queued ? "processed" : "skipped";
    }

    case "email.abstract":
      await queueAbstractEmail(payload as AbstractEmailPayload);
      return "processed";

    case "email.sponsorship": {
      const input = payload as SponsorshipEmailPayload;
      const queued = await queueSponsorshipEmail(
        input.trigger,
        input.eventId,
        input.input,
      );
      return queued ? "processed" : "skipped";
    }

    default:
      throw new Error(`Unknown outbox event type: ${type}`);
  }
}
