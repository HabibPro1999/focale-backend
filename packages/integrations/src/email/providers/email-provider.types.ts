// =============================================================================
// EMAIL PROVIDER CONTRACT
// Shared types + interface implemented by each email provider (SendGrid, Resend)
// =============================================================================

import { abstractHtmlToText } from "@app/shared";
import { integrationsConfig } from "../../config";

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
  fromEmail?: string; // Optional server-approved, provider-verified networking sender override.
  senderClientId?: string; // Persisted event client ID; required for a From override.
  replyTo?: string; // Reply-to email (e.g., client email)
  replyToName?: string;
  subject: string;
  html: string;
  plainText?: string;
  trackingId?: string; // Internal emailLog id — used to correlate webhook events
  categories?: string[];
  attachments?: EmailAttachment[];
}

/**
 * What one provider call did (3.6):
 * - `accepted`: the provider took the email.
 * - `rejected`: a definitive refusal (an HTTP error response, or an error
 *   raised before the request left). Nothing was sent; retrying is safe.
 * - `ambiguous`: the request may have reached the provider (timeout,
 *   connection reset, an unknown error). Sending it again blind could send it
 *   twice.
 */
export type SendEmailOutcome = "accepted" | "rejected" | "ambiguous";

export interface SendEmailResult {
  outcome: SendEmailOutcome;
  /** `outcome === "accepted"` (for callers that only need yes or no). */
  success: boolean;
  messageId?: string;
  error?: string;
  /** HTTP status of the provider's error response, when there was one. */
  statusCode?: number;
  /**
   * Ambiguous only: sending again with the same `trackingId` cannot send it
   * twice (the provider deduplicates on it as an idempotency key).
   */
  idempotentRetry?: boolean;
}

export function acceptedSend(messageId: string | undefined): SendEmailResult {
  return { outcome: "accepted", success: true, messageId };
}

export function rejectedSend(error: string, statusCode?: number): SendEmailResult {
  return { outcome: "rejected", success: false, error, ...(statusCode ? { statusCode } : {}) };
}

export function ambiguousSend(
  error: string,
  options: { statusCode?: number; idempotentRetry?: boolean } = {},
): SendEmailResult {
  return {
    outcome: "ambiguous",
    success: false,
    error,
    ...(options.statusCode ? { statusCode: options.statusCode } : {}),
    idempotentRetry: options.idempotentRetry === true,
  };
}

// -----------------------------------------------------------------------------
// WEBHOOKS
// -----------------------------------------------------------------------------

/**
 * Provider-neutral event vocabulary. Matches the argument accepted by
 * `updateEmailStatusFromWebhook` so the route needs no provider-specific mapping.
 */
export type NormalizedEventType =
  /** The provider accepted the email (SendGrid `processed`, Resend `email.sent`). */
  | "processed"
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

/** Upper bound for one provider send request (SendGrid client timeout, Resend fetch abort). */
export const EMAIL_PROVIDER_TIMEOUT_MS = 15_000;

// -----------------------------------------------------------------------------
// SHARED UTILITIES
// -----------------------------------------------------------------------------

/**
 * Resolve the shared sender identity from config, which keeps the legacy
 * fallback chain (EMAIL_FROM_* ?? SENDGRID_FROM_* ?? default). Note: the
 * SENDGRID_FROM_* fallback applies even under Resend — a legacy naming leak
 * kept on purpose.
 */
export function resolveEmailSender(): { fromEmail: string; fromName: string } {
  const { fromEmail, fromName } = integrationsConfig().email;
  return { fromEmail, fromName };
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
 * Strip HTML tags to produce a plain-text fallback. Style/script blocks are
 * removed first (their text content must not leak), then the shared
 * abstractHtmlToText does tag stripping + entity decoding.
 */
export function stripHtml(html: string): string {
  return abstractHtmlToText(
    html.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, ""),
  );
}
