import type { AppEvent } from "@core/events/types.js";
import type { AutomaticEmailTrigger } from "@modules/email/email.schema.js";
import type { AbstractEmailTrigger } from "@/generated/prisma/client.js";
import type { QueueSponsorshipEmailInput } from "@modules/email/email-queue.service.js";

export type OutboxEventStatus =
  | "PENDING"
  | "PROCESSING"
  | "PROCESSED"
  | "FAILED"
  | "DEAD_LETTERED"
  | "SKIPPED";

export interface TriggeredEmailPayload {
  trigger: AutomaticEmailTrigger;
  eventId: string;
  registration: {
    id: string;
    email: string;
    firstName?: string | null;
    lastName?: string | null;
  };
}

export interface AbstractEmailPayload {
  trigger: AbstractEmailTrigger;
  abstractId: string;
  recipientOverride?: { email: string; name?: string | null };
  extraContext?: Record<string, string | number | null | undefined>;
}

export interface SponsorshipEmailPayload {
  trigger: AutomaticEmailTrigger;
  eventId: string;
  input: QueueSponsorshipEmailInput;
}

export type OutboxPayloadByType = {
  "realtime.emit": AppEvent;
  "email.triggered": TriggeredEmailPayload;
  "email.abstract": AbstractEmailPayload;
  "email.sponsorship": SponsorshipEmailPayload;
};

export type OutboxEventType = keyof OutboxPayloadByType;

export const REALTIME_EMIT_TYPE = "realtime.emit" satisfies OutboxEventType;

export type RealtimeOutboxPayload = OutboxPayloadByType[typeof REALTIME_EMIT_TYPE];
