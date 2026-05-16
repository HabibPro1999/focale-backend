import { eventBus } from "@core/events/bus.js";
import { queueTriggeredEmail, queueSponsorshipEmail } from "@email";
import { queueAbstractEmail } from "@modules/abstracts/abstracts.email-queue.js";
import type {
  AbstractEmailPayload,
  OutboxEventType,
  OutboxPayloadByType,
  SponsorshipEmailPayload,
  TriggeredEmailPayload,
} from "./types.js";

export type OutboxHandlerResult = "processed" | "skipped";

export async function handleOutboxEvent(
  type: string,
  payload: unknown,
): Promise<OutboxHandlerResult> {
  switch (type as OutboxEventType) {
    case "realtime.emit":
      eventBus.emit(payload as OutboxPayloadByType["realtime.emit"]);
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
