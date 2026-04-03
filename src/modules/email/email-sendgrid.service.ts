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
  replyTo?: string; // Reply-to email (e.g., client email)
  replyToName?: string;
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

export type SendGridEventType =
  | "processed"
  | "dropped"
  | "blocked"
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
      ...(input.replyTo && {
        replyTo: {
          email: input.replyTo,
          name: input.replyToName || input.replyTo,
        },
      }),
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
    logger.error(
      "SendGrid webhook public key not configured — rejecting webhook request",
    );
    return false;
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
