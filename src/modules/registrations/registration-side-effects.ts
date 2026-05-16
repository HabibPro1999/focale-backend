import {
  enqueueRealtimeOutboxEvent,
  enqueueTriggeredEmailOutboxEvent,
  type OutboxClient,
} from "@core/outbox";
import type { AppEvent } from "@core/events/types.js";

export type RegistrationPostCommitEvent = AppEvent;

interface QueueRegistrationCreatedEmailInput {
  eventId: string;
  registration: {
    id: string;
    email: string;
    firstName?: string | null;
    lastName?: string | null;
  };
  failureMessage: string;
}

export async function emitRegistrationPostCommitEvents(
  client: OutboxClient,
  events: RegistrationPostCommitEvent[],
): Promise<void> {
  await Promise.all(events.map((ev) => enqueueRealtimeOutboxEvent(client, ev)));
}

export async function queueRegistrationCreatedEmail(
  client: OutboxClient,
  input: QueueRegistrationCreatedEmailInput,
): Promise<void> {
  const { eventId, registration } = input;

  await enqueueTriggeredEmailOutboxEvent(
    client,
    {
      trigger: "REGISTRATION_CREATED",
      eventId,
      registration,
    },
    `email:triggered:REGISTRATION_CREATED:${registration.id}`,
  );
}
