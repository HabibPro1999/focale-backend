/**
 * Realtime event envelopes emitted after DB mutations and consumed by the
 * SSE route. Payloads carry only IDs and minimal fields — admins refetch the
 * full record through existing authenticated GET routes.
 */

export type RegistrationEventType =
  | "registration.created"
  | "registration.updated"
  | "registration.deleted"
  | "registration.checkedIn"
  | "registration.paymentConfirmed";

export type SponsorshipEventType =
  | "sponsorship.created"
  | "sponsorship.updated"
  | "sponsorship.deleted"
  | "sponsorship.cancelled"
  | "sponsorship.linked"
  | "sponsorship.unlinked"
  | "sponsorship.batchCreated";

export type EventAccessEventType = "eventAccess.countsChanged";

export type EmailLogEventType = "emailLog.statusChanged";

export type AbstractEventType =
  | "abstract.reviewCompleted"
  | "abstract.scoreDiverged"
  | "abstract.finalized"
  | "abstract.reopened";

export type AppEventType =
  | RegistrationEventType
  | SponsorshipEventType
  | EventAccessEventType
  | EmailLogEventType
  | AbstractEventType;

interface BaseEvent<T extends AppEventType, P> {
  type: T;
  clientId: string;
  eventId?: string;
  payload: P;
  ts: number;
}

export type RegistrationEvent = BaseEvent<
  RegistrationEventType,
  { id: string; [k: string]: unknown }
>;

export type SponsorshipEvent = BaseEvent<
  SponsorshipEventType,
  { id: string; registrationId?: string; batchId?: string; count?: number; [k: string]: unknown }
>;

export type EventAccessEvent = BaseEvent<
  EventAccessEventType,
  { id: string; accessIds: string[] }
>;

export type EmailLogEvent = BaseEvent<
  EmailLogEventType,
  { id: string; status: string; registrationId?: string; [k: string]: unknown }
>;

export type AbstractEvent = BaseEvent<
  AbstractEventType,
  { id: string; status?: string; averageScore?: number | null; reviewCount?: number; code?: string | null; [k: string]: unknown }
>;

export type AppEvent =
  | RegistrationEvent
  | SponsorshipEvent
  | EventAccessEvent
  | EmailLogEvent
  | AbstractEvent;

export const BYPASS_DEBOUNCE_TYPES = new Set<AppEventType>([
  "registration.checkedIn",
  "registration.paymentConfirmed",
]);
