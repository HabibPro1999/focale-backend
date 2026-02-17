// ============================================================================
// Email Module - Barrel Export
// ============================================================================

// ============================================================================
// Queue functions (external: registrations, sponsorships, index.ts)
// ============================================================================

export {
  queueTriggeredEmail,
  queueSponsorshipEmail,
  processEmailQueue,
} from "./email-queue.service.js";

// ============================================================================
// Variable service (external: sponsorships)
// ============================================================================

export {
  buildBatchEmailContext,
  buildLinkedSponsorshipContext,
} from "./email-variable.service.js";

export type {
  BatchEmailContextInput,
  LinkedSponsorshipContextInput,
} from "./email-variable.service.js";

// ============================================================================
// Routes (external: server.ts)
// ============================================================================

export { emailRoutes } from "./email.routes.js";
export { emailWebhookRoutes } from "./email-webhook.routes.js";
