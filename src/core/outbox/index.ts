export {
  enqueueAbstractEmailOutboxEvent,
  enqueueOutboxEvent,
  enqueueRealtimeOutboxEvent,
  enqueueSponsorshipEmailOutboxEvent,
  enqueueTriggeredEmailOutboxEvent,
  getOutboxHealth,
  processOutboxEvents,
} from "./outbox.service.js";
export { startRealtimeOutboxPump } from "./realtime-pump.js";
export type {
  OutboxClient,
  OutboxProcessingScope,
  ProcessOutboxResult,
} from "./outbox.service.js";
export type {
  AbstractEmailPayload,
  OutboxEventStatus,
  OutboxEventType,
  SponsorshipEmailPayload,
  TriggeredEmailPayload,
} from "./types.js";
