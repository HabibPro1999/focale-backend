// =============================================================================
// EMAIL PROVIDER CONTRACT
// Shared types + interface implemented by each email provider (SendGrid, Resend)
// =============================================================================

// -----------------------------------------------------------------------------
// SEND
// -----------------------------------------------------------------------------

export interface EmailAttachment {
  content: string; // base64 encoded
  filename: string;
  type: string; // MIME type
  disposition: "attachment" | "inline";
}

export interface SendEmailInput {
  to: string;
  toName?: string;
  fromName?: string; // Event name to use as sender name
  replyTo?: string; // Reply-to email (e.g., client email)
  replyToName?: string;
  subject: string;
  html: string;
  plainText?: string;
  trackingId?: string; // Internal emailLog id — used to correlate webhook events
  categories?: string[];
  attachments?: EmailAttachment[];
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

// -----------------------------------------------------------------------------
// WEBHOOKS
// -----------------------------------------------------------------------------

/**
 * Provider-neutral event vocabulary. Matches the argument accepted by
 * `updateEmailStatusFromWebhook` so the route needs no provider-specific mapping.
 */
export type NormalizedEventType =
  | "delivered"
  | "open"
  | "click"
  | "bounce"
  | "dropped"
  | "blocked"
  | "spam_report"
  | "unsubscribe";

export interface NormalizedWebhookEvent {
  emailLogId: string;
  type: NormalizedEventType;
  metadata?: { url?: string; reason?: string };
}

/** Events acknowledged for observability but not mapped to a status change. */
export interface LogOnlyWebhookEvent {
  type: string;
  emailLogId?: string;
  reason?: string;
}

export type WebhookHeaders = Record<string, string | string[] | undefined>;

/**
 * Result of verifying + parsing a provider webhook request.
 * The route maps `reason` → HTTP status and applies `events` to the queue.
 */
export type WebhookResult =
  | {
      ok: false;
      reason: "unconfigured" | "invalid_signature" | "stale" | "bad_payload";
    }
  | {
      ok: true;
      events: NormalizedWebhookEvent[];
      logOnly: LogOnlyWebhookEvent[];
    };

// -----------------------------------------------------------------------------
// PROVIDER INTERFACE
// -----------------------------------------------------------------------------

export interface EmailProvider {
  readonly name: "sendgrid" | "resend";
  /** Whether the provider has the credentials it needs to send. */
  isConfigured(): boolean;
  sendEmail(input: SendEmailInput): Promise<SendEmailResult>;
  /**
   * Verify the signature, parse, and normalize a raw webhook request.
   * Owns all provider-specific concerns (header names, signature scheme,
   * timestamp tolerance, event mapping). The route stays provider-agnostic.
   */
  handleWebhook(
    rawBody: Buffer,
    headers: WebhookHeaders,
  ): WebhookResult | Promise<WebhookResult>;
}

// -----------------------------------------------------------------------------
// SHARED UTILITIES
// -----------------------------------------------------------------------------

/**
 * Resolve the shared sender identity from env, preserving the legacy fallback
 * chain (EMAIL_FROM_* ?? SENDGRID_FROM_* ?? default). Note: the SENDGRID_FROM_*
 * fallback applies even under Resend — a legacy naming leak kept on purpose.
 */
export function resolveEmailSender(): { fromEmail: string; fromName: string } {
  return {
    fromEmail:
      process.env.EMAIL_FROM_EMAIL ??
      process.env.SENDGRID_FROM_EMAIL ??
      "noreply@example.com",
    fromName:
      process.env.EMAIL_FROM_NAME ??
      process.env.SENDGRID_FROM_NAME ??
      "Event Platform",
  };
}

/** Read a single header value (HTTP headers may arrive as string[]). */
export function getHeader(
  headers: WebhookHeaders,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Strip HTML tags to produce a plain-text fallback.
 * Removes style/script tags completely, then strips remaining HTML.
 */
export function stripHtml(html: string): string {
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
