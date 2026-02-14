// ============================================================================
// Email Module - Barrel Export
// ============================================================================

// ============================================================================
// Schemas
// ============================================================================

export {
  EmailTemplateCategorySchema,
  AutomaticEmailTriggerSchema,
  EmailStatusSchema,
  TiptapDocumentSchema,
  CreateEmailTemplateSchema,
  UpdateEmailTemplateSchema,
  ListEmailTemplatesQuerySchema,
  BulkSendEmailSchema,
  BulkSendFilterSchema,
  TestSendEmailSchema,
  EmailTemplateIdParamSchema,
  EventIdParamSchema,
} from "./email.schema.js";

// ============================================================================
// Schema Types
// ============================================================================

export type {
  EmailTemplateCategory,
  AutomaticEmailTrigger,
  EmailStatus,
  TiptapDocument,
  CreateEmailTemplateInput,
  UpdateEmailTemplateInput,
  ListEmailTemplatesQuery,
  BulkSendEmailInput,
  BulkSendFilter,
  TestSendEmailInput,
} from "./email.schema.js";

// ============================================================================
// Email Template Service
// ============================================================================

export {
  createEmailTemplate,
  getEmailTemplateById,
  getEmailTemplateWithEvent,
  getEmailTemplateClientId,
  listEmailTemplates,
  getTemplateByTrigger,
  updateEmailTemplate,
  deleteEmailTemplate,
  duplicateEmailTemplate,
} from "./email-template.service.js";

// ============================================================================
// Email Variable Service
// ============================================================================

export {
  BASE_VARIABLES,
  getAvailableVariables,
  buildEmailContext,
  buildEmailContextWithAccess,
  resolveVariables,
  sanitizeForHtml,
  sanitizeUrl,
  getSampleEmailContext,
  buildBatchEmailContext,
  buildLinkedSponsorshipContext,
} from "./email-variable.service.js";

export type {
  BatchEmailContextInput,
  LinkedSponsorshipContextInput,
} from "./email-variable.service.js";

// ============================================================================
// Email Queue Service
// ============================================================================

export {
  queueEmail,
  queueBulkEmails,
  queueTriggeredEmail,
  queueSponsorshipEmail,
  processEmailQueue,
  updateEmailStatusFromWebhook,
  getQueueStats,
  getQueuedEmailCountForTemplate,
} from "./email-queue.service.js";

export type {
  QueueEmailInput,
  QueueSponsorshipEmailInput,
  ProcessQueueResult,
} from "./email-queue.service.js";

// ============================================================================
// Email SendGrid Service
// ============================================================================

export {
  sendEmail,
  sendBatchEmails,
  verifyWebhookSignature,
  WebhookHeaders,
  parseWebhookEvents,
  isFailureEvent,
  isDeliveryEvent,
  isEngagementEvent,
  isSendGridConfigured,
  getSendGridStatus,
} from "./email-sendgrid.service.js";

export type {
  SendEmailInput,
  SendEmailResult,
  BatchEmailInput,
  BatchSendResult,
  SendGridEventType,
  SendGridWebhookEvent,
} from "./email-sendgrid.service.js";

// ============================================================================
// Email Renderer Service
// ============================================================================

export {
  renderTemplateToMjml,
  compileMjmlToHtml,
  extractPlainText,
  renderNode,
  renderInlineContent,
  renderInlineNode,
  applyMarks,
  escapeHtml,
} from "./email-renderer.service.js";

// ============================================================================
// Types (from email.types.ts)
// ============================================================================

export type {
  TiptapDocument as TiptapDocumentType,
  TiptapNode,
  TiptapMark,
  VariableMentionNode,
  EmailContext,
  MjmlCompilationResult,
  VariableDefinition,
} from "./email.types.js";

// ============================================================================
// Routes
// ============================================================================

export { emailRoutes } from "./email.routes.js";
export { emailWebhookRoutes } from "./email-webhook.routes.js";
