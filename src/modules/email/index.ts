// Email module — public interface

// Routes
export { emailRoutes } from "./email.routes.js";
export { emailWebhookRoutes } from "./email.webhook.routes.js";

// Queue
export {
  queueTriggeredEmail,
  queueSponsorshipEmail,
  queueBulkCertificateEmails,
  processEmailQueue,
  getEmailQueueHealth,
} from "./email-queue.service.js";

// Context builders (consumed by sponsorship module)
export {
  buildBatchEmailContext,
  buildLinkedSponsorshipContext,
} from "./email-context.js";
