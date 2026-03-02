// =============================================================================
// SENDGRID EMAIL SERVICE
// Handles sending emails via SendGrid API with tracking and webhook processing
// =============================================================================

import sgMail from "@sendgrid/mail";
import { EventWebhook, EventWebhookHeader } from "@sendgrid/eventwebhook";
import { logger } from "@shared/utils/logger.js";
import { config } from "@config/app.config.js";

// =============================================================================
// CONFIGURATION
// =============================================================================

const SENDGRID_API_KEY = config.sendgrid.apiKey;
const SENDGRID_WEBHOOK_PUBLIC_KEY = config.sendgrid.webhookPublicKey;
const FROM_EMAIL = config.sendgrid.fromEmail;
const FROM_NAME = config.sendgrid.fromName;

// Initialize SendGrid with API key
if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
}

// =============================================================================
// TYPES
// =============================================================================

export interface SendEmailInput {
  to: string;
  toName?: string;
  fromName?: string; // Event name to use as sender name
  subject: string;
  html: string;
  plainText?: string;
  trackingId?: string; // Used in customArgs for webhook correlation
  categories?: string[];
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface BatchEmailInput {
  to: string;
  toName?: string;
  fromName?: string; // Event name to use as sender name
  subject: string;
  html: string;
  plainText?: string;
  trackingId: string;
  categories?: string[];
}

export interface BatchSendResult {
  total: number;
  sent: number;
  failed: number;
  results: Array<{
    trackingId: string;
    success: boolean;
    messageId?: string;
    error?: string;
  }>;
}

export type SendGridEventType =
  | "processed"
  | "dropped"
  | "delivered"
  | "deferred"
  | "bounce"
  | "open"
  | "click"
  | "spam_report"
  | "unsubscribe"
  | "group_unsubscribe"
  | "group_resubscribe";

export interface SendGridWebhookEvent {
  email: string;
  event: SendGridEventType;
  sg_message_id: string;
  timestamp: number;
  emailLogId?: string; // From customArgs
  url?: string; // For click events
  reason?: string; // For bounce/dropped
  type?: string; // Bounce type (bounce, blocked)
  status?: string; // SMTP status code
  category?: string[];
  sg_event_id?: string;
  ip?: string;
  useragent?: string;
}

// =============================================================================
// SEND SINGLE EMAIL
// =============================================================================

/**
 * Send a single email via SendGrid
 * @param input - Email details including recipient, subject, and content
 * @returns Result with success status and optional message ID
 */
export async function sendEmail(
  input: SendEmailInput,
): Promise<SendEmailResult> {
  if (!SENDGRID_API_KEY) {
    logger.warn("SendGrid API key not configured, skipping email send");
    return { success: false, error: "SendGrid not configured" };
  }

  try {
    const msg: sgMail.MailDataRequired = {
      to: input.toName ? { email: input.to, name: input.toName } : input.to,
      from: { email: FROM_EMAIL, name: input.fromName || FROM_NAME },
      subject: input.subject,
      text: input.plainText || stripHtml(input.html),
      html: input.html,
      trackingSettings: {
        clickTracking: { enable: true, enableText: false },
        openTracking: { enable: true },
      },
      ...(input.trackingId && {
        customArgs: { emailLogId: input.trackingId },
      }),
      ...(input.categories && { categories: input.categories }),
    };

    const [response] = await sgMail.send(msg);

    // Extract message ID from response headers
    const messageId = response.headers["x-message-id"] as string | undefined;

    logger.info(
      { to: input.to, messageId, trackingId: input.trackingId },
      "Email sent successfully via SendGrid",
    );

    return {
      success: true,
      messageId: messageId || undefined,
    };
  } catch (error: unknown) {
    const err = error as Error & {
      response?: { body?: { errors?: Array<{ message: string }> } };
      code?: number;
    };
    const errorMessage =
      err.response?.body?.errors?.[0]?.message ||
      err.message ||
      "Unknown error";

    logger.error(
      {
        to: input.to,
        error: errorMessage,
        trackingId: input.trackingId,
        statusCode: err.code,
      },
      "Failed to send email via SendGrid",
    );

    return {
      success: false,
      error: errorMessage,
    };
  }
}

// =============================================================================
// SEND BATCH EMAILS (for campaigns)
// =============================================================================

/**
 * Send multiple emails in batches via SendGrid
 * Processes emails in configurable batch sizes to respect API limits
 *
 * @param emails - Array of email inputs to send
 * @param batchSize - Number of emails per batch (default: 100, max: 1000)
 * @returns Aggregated results for all emails
 */
export async function sendBatchEmails(
  emails: BatchEmailInput[],
  batchSize = 100,
): Promise<BatchSendResult> {
  const result: BatchSendResult = {
    total: emails.length,
    sent: 0,
    failed: 0,
    results: [],
  };

  if (!SENDGRID_API_KEY) {
    logger.warn("SendGrid API key not configured, skipping batch send");
    return {
      ...result,
      failed: emails.length,
      results: emails.map((e) => ({
        trackingId: e.trackingId,
        success: false,
        error: "SendGrid not configured",
      })),
    };
  }

  if (emails.length === 0) {
    return result;
  }

  // Ensure batch size is within limits
  const safeBatchSize = Math.min(Math.max(batchSize, 1), 1000);

  // Process in batches
  for (let i = 0; i < emails.length; i += safeBatchSize) {
    const batch = emails.slice(i, i + safeBatchSize);
    const batchIndex = Math.floor(i / safeBatchSize);

    const messages: sgMail.MailDataRequired[] = batch.map((email) => ({
      to: email.toName ? { email: email.to, name: email.toName } : email.to,
      from: { email: FROM_EMAIL, name: email.fromName || FROM_NAME },
      subject: email.subject,
      text: email.plainText || stripHtml(email.html),
      html: email.html,
      trackingSettings: {
        clickTracking: { enable: true, enableText: false },
        openTracking: { enable: true },
      },
      customArgs: { emailLogId: email.trackingId },
      ...(email.categories && { categories: email.categories }),
    }));

    try {
      // sendMultiple handles array of messages
      await sgMail.send(messages);

      // sendMultiple doesn't return individual results
      // If no error, assume all succeeded
      for (const email of batch) {
        result.results.push({
          trackingId: email.trackingId,
          success: true,
        });
        result.sent++;
      }

      logger.info(
        {
          batchIndex,
          batchSize: batch.length,
          totalBatches: Math.ceil(emails.length / safeBatchSize),
        },
        "Batch sent successfully via SendGrid",
      );
    } catch (error: unknown) {
      const err = error as Error & {
        response?: { body?: { errors?: Array<{ message: string }> } };
      };
      const errorMessage =
        err.response?.body?.errors?.[0]?.message ||
        err.message ||
        "Unknown error";

      // If batch fails, mark all emails in batch as failed
      for (const email of batch) {
        result.results.push({
          trackingId: email.trackingId,
          success: false,
          error: errorMessage,
        });
        result.failed++;
      }

      logger.error(
        { batchIndex, error: errorMessage, batchSize: batch.length },
        "Batch send failed via SendGrid",
      );
    }

    // Add small delay between batches to avoid rate limiting
    if (i + safeBatchSize < emails.length) {
      await delay(100);
    }
  }

  logger.info(
    { total: result.total, sent: result.sent, failed: result.failed },
    "Batch email send completed",
  );

  return result;
}

// =============================================================================
// WEBHOOK SIGNATURE VERIFICATION
// =============================================================================

/**
 * Verify SendGrid webhook signature using ECDSA
 * SendGrid uses public key cryptography for webhook verification
 *
 * @param payload - Raw request body as string or Buffer
 * @param signature - Value from X-Twilio-Email-Event-Webhook-Signature header
 * @param timestamp - Value from X-Twilio-Email-Event-Webhook-Timestamp header
 * @returns true if signature is valid
 */
export function verifyWebhookSignature(
  payload: string | Buffer,
  signature: string,
  timestamp: string,
): boolean {
  if (!SENDGRID_WEBHOOK_PUBLIC_KEY) {
    logger.warn(
      "SendGrid webhook public key not configured, skipping verification",
    );
    return !config.isProduction;
  }

  try {
    const eventWebhook = new EventWebhook();
    const ecPublicKey = eventWebhook.convertPublicKeyToECDSA(
      SENDGRID_WEBHOOK_PUBLIC_KEY,
    );

    const isValid = eventWebhook.verifySignature(
      ecPublicKey,
      payload,
      signature,
      timestamp,
    );

    if (!isValid) {
      logger.warn("Invalid SendGrid webhook signature");
    }

    return isValid;
  } catch (error) {
    logger.error({ error }, "Failed to verify SendGrid webhook signature");
    return false;
  }
}

/**
 * Get header names for webhook verification
 * Use these constants when extracting headers from the request
 */
export const WebhookHeaders = {
  SIGNATURE: EventWebhookHeader.SIGNATURE(),
  TIMESTAMP: EventWebhookHeader.TIMESTAMP(),
} as const;

// =============================================================================
// WEBHOOK EVENT PARSING
// =============================================================================

/**
 * Parse SendGrid webhook payload into typed events
 * SendGrid sends an array of event objects
 *
 * @param body - Parsed JSON body (array of events)
 * @returns Array of typed webhook events
 */
export function parseWebhookEvents(body: unknown): SendGridWebhookEvent[] {
  if (!Array.isArray(body)) {
    logger.warn(
      { bodyType: typeof body },
      "Invalid webhook payload: expected array",
    );
    return [];
  }

  return body.map((event: Record<string, unknown>) => ({
    email: String(event.email || ""),
    event: String(event.event || "") as SendGridEventType,
    sg_message_id: String(event.sg_message_id || ""),
    timestamp: Number(event.timestamp || 0),
    // Custom args are flattened into the event object
    emailLogId: event.emailLogId as string | undefined,
    // Event-specific fields
    url: event.url as string | undefined,
    reason: event.reason as string | undefined,
    type: event.type as string | undefined,
    status: event.status as string | undefined,
    category: event.category as string[] | undefined,
    sg_event_id: event.sg_event_id as string | undefined,
    ip: event.ip as string | undefined,
    useragent: event.useragent as string | undefined,
  }));
}

/**
 * Check if an event represents a delivery failure
 */
export function isFailureEvent(event: SendGridWebhookEvent): boolean {
  return ["bounce", "dropped", "spam_report"].includes(event.event);
}

/**
 * Check if an event represents successful delivery
 */
export function isDeliveryEvent(event: SendGridWebhookEvent): boolean {
  return event.event === "delivered";
}

/**
 * Check if an event represents engagement (open/click)
 */
export function isEngagementEvent(event: SendGridWebhookEvent): boolean {
  return ["open", "click"].includes(event.event);
}

// =============================================================================
// UTILITIES
// =============================================================================

/**
 * Strip HTML tags from content for plain text version
 * Removes style/script tags completely, then strips remaining HTML
 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Check if SendGrid is configured and ready to send emails
 */
export function isSendGridConfigured(): boolean {
  return !!SENDGRID_API_KEY;
}

/**
 * Get SendGrid configuration status for health checks
 */
export function getSendGridStatus(): {
  configured: boolean;
  webhookVerificationEnabled: boolean;
} {
  return {
    configured: !!SENDGRID_API_KEY,
    webhookVerificationEnabled: !!SENDGRID_WEBHOOK_PUBLIC_KEY,
  };
}

/**
 * Simple delay utility for rate limiting
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
