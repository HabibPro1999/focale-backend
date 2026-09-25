import { resolveVerifiedNetworkingSender } from "./networking-sender";
// =============================================================================
// RESEND EMAIL PROVIDER
// Sends via the Resend API; verifies + normalizes Resend (Svix-signed) webhooks.
// =============================================================================

import {
  Resend,
  type CreateEmailOptions,
  type CreateEmailRequestOptions,
  type WebhookEventPayload,
} from "resend";
import { logger } from "../../logger";
import { integrationsConfig } from "../../config";
import {
  EMAIL_PROVIDER_TIMEOUT_MS,
  acceptedSend,
  ambiguousSend,
  rejectedSend,
  getHeader,
  resolveEmailSender,
  stripHtml,
  type EmailProvider,
  type NormalizedWebhookEvent,
  type LogOnlyWebhookEvent,
  type SendEmailInput,
  type SendEmailResult,
  type WebhookHeaders,
  type WebhookResult,
} from "./email-provider.types";

// Resend tag names AND values may only contain ASCII letters, digits, "_" or
// "-" (max 256 chars). An unsanitized value rejects the entire send.
export function sanitizeTagValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256);
}

function formatAddress(name: string | undefined, email: string): string {
  return name ? `${name} <${email}>` : email;
}

export interface ResendFrom {
  fromEmail: string;
  fromName: string;
}

/**
 * Map our provider-neutral SendEmailInput onto a Resend send payload.
 * Pure (no network / config access) so it can be unit-tested directly.
 */
export function buildResendPayload(
  input: SendEmailInput,
  from: ResendFrom,
): CreateEmailOptions {
  const tags: Array<{ name: string; value: string }> = [];
  if (input.trackingId) {
    // Carries our internal emailLog id; echoed back as data.tags.email_log_id.
    tags.push({
      name: "email_log_id",
      value: sanitizeTagValue(input.trackingId),
    });
  }
  if (input.categories?.length) {
    const value = sanitizeTagValue(input.categories.join("_"));
    if (value) tags.push({ name: "category", value });
  }

  const payload: CreateEmailOptions = {
    from: formatAddress(input.fromName || from.fromName, from.fromEmail),
    to: formatAddress(input.toName, input.to),
    subject: input.subject,
    html: input.html,
    text: input.plainText || stripHtml(input.html),
    ...(input.replyTo && {
      replyTo: formatAddress(input.replyToName, input.replyTo),
    }),
    ...(tags.length && { tags }),
    ...(input.attachments?.length && {
      attachments: input.attachments.map((att) => ({
        filename: att.filename,
        // Our attachments are base64; Resend wants the raw bytes.
        content: Buffer.from(att.content, "base64"),
        contentType: att.type,
        // Resend has no per-attachment disposition; inline is not supported.
      })),
    }),
  };

  return payload;
}

/**
 * Map a verified Resend webhook event onto our normalized vocabulary.
 * Resend delivers a single event per request. Pure / testable.
 */
export function normalizeResendEvents(payload: WebhookEventPayload): {
  events: NormalizedWebhookEvent[];
  logOnly: LogOnlyWebhookEvent[];
} {
  const events: NormalizedWebhookEvent[] = [];
  const logOnly: LogOnlyWebhookEvent[] = [];

  switch (payload.type) {
    case "email.delivered": {
      const emailLogId = payload.data.tags?.email_log_id;
      if (emailLogId) events.push({ emailLogId, type: "delivered" });
      break;
    }
    case "email.opened": {
      const emailLogId = payload.data.tags?.email_log_id;
      if (emailLogId) events.push({ emailLogId, type: "open" });
      break;
    }
    case "email.clicked": {
      const emailLogId = payload.data.tags?.email_log_id;
      if (emailLogId) {
        events.push({
          emailLogId,
          type: "click",
          metadata: { url: payload.data.click?.link },
        });
      }
      break;
    }
    case "email.bounced": {
      const emailLogId = payload.data.tags?.email_log_id;
      if (emailLogId) {
        events.push({
          emailLogId,
          type: "bounce",
          metadata: { reason: payload.data.bounce?.message },
        });
      }
      break;
    }
    case "email.complained": {
      const emailLogId = payload.data.tags?.email_log_id;
      if (emailLogId) {
        events.push({
          emailLogId,
          type: "spam_report",
          metadata: { reason: "Recipient reported email as spam" },
        });
      }
      break;
    }
    case "email.failed": {
      const emailLogId = payload.data.tags?.email_log_id;
      if (emailLogId) {
        events.push({
          emailLogId,
          type: "dropped",
          metadata: { reason: payload.data.failed?.reason },
        });
      }
      break;
    }
    case "email.suppressed": {
      const emailLogId = payload.data.tags?.email_log_id;
      if (emailLogId) {
        events.push({
          emailLogId,
          type: "dropped",
          metadata: {
            reason: payload.data.suppressed?.message ?? "Recipient suppressed",
          },
        });
      }
      break;
    }
    case "email.sent": {
      const emailLogId = payload.data.tags?.email_log_id;
      if (emailLogId) events.push({ emailLogId, type: "processed" });
      break;
    }
    case "email.scheduled":
    case "email.delivery_delayed": {
      logOnly.push({
        type: payload.type,
        emailLogId: payload.data.tags?.email_log_id,
      });
      break;
    }
    default:
      // contact.*, domain.*, email.received — not email-status events.
      break;
  }

  return { events, logOnly };
}

/** The error half of a Resend SDK response (`{ data, error }`). */
export interface ResendSendError {
  name?: string;
  message?: string;
  statusCode?: number | null;
}

/**
 * Classify a Resend send error (3.6). The SDK reports a request that got no
 * response (network error, our timeout abort) as `statusCode: null`.
 * - no response, a 5xx, or `concurrent_idempotent_requests` (the first request
 *   with this key still running): `ambiguous`, retryable under the same
 *   idempotency key when one was sent;
 * - `invalid_idempotent_request` (the key was already used with another
 *   payload, so an earlier request reached Resend): `ambiguous`, not retryable;
 * - any other HTTP error (validation, auth, rate limit, quota): `rejected`.
 */
export function classifyResendError(error: ResendSendError, idempotent: boolean): SendEmailResult {
  const message = error.message || error.name || "Unknown error";
  const statusCode = typeof error.statusCode === "number" ? error.statusCode : undefined;
  if (error.name === "invalid_idempotent_request") {
    return ambiguousSend(message, { statusCode, idempotentRetry: false });
  }
  if (statusCode === undefined || statusCode >= 500 || error.name === "concurrent_idempotent_requests") {
    return ambiguousSend(message, { statusCode, idempotentRetry: idempotent });
  }
  return rejectedSend(message, statusCode);
}

export interface ResendProviderOptions {
  apiKey?: string;
  webhookSecret?: string;
  fromEmail: string;
  fromName: string;
}

export class ResendProvider implements EmailProvider {
  readonly name = "resend" as const;

  private readonly apiKey?: string;
  private readonly webhookSecret?: string;
  private readonly from: ResendFrom;
  private readonly client: Resend;

  constructor(opts: ResendProviderOptions) {
    this.apiKey = opts.apiKey;
    this.webhookSecret = opts.webhookSecret;
    this.from = { fromEmail: opts.fromEmail, fromName: opts.fromName };
    // The Resend constructor throws on a missing key, which would make our own
    // unconfigured handling (isConfigured, the "Resend not configured" send
    // result, handleWebhook's `unconfigured` -> 503 path) unreachable. Webhook
    // signature verification needs no API key, so fall back to a placeholder;
    // sendEmail's `!this.apiKey` guard keeps it off the network.
    this.client = new Resend(this.apiKey || "re_unconfigured_placeholder");
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
    if (!this.apiKey) {
      logger.warn("Resend API key not configured, skipping email send");
      return rejectedSend("Resend not configured");
    }

    let payload: CreateEmailOptions;
    try {
      const approvedFrom = await resolveVerifiedNetworkingSender(input, this.name, this.apiKey);
      payload = buildResendPayload(input, approvedFrom ? { ...this.from, fromEmail: approvedFrom } : this.from);
    } catch (error: unknown) {
      // Before the request: nothing reached Resend.
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ to: input.to, error: message, trackingId: input.trackingId }, "Failed to prepare email for Resend");
      return rejectedSend(message);
    }

    // The emailLog id is the idempotency key: Resend sends one email per key
    // (for 24 h), so a retry after an ambiguous outcome cannot send twice.
    const idempotent = Boolean(input.trackingId);
    // The SDK has no timeout option but spreads request options into its
    // fetch call, so the abort signal bounds the request.
    const requestOptions = {
      ...(input.trackingId ? { idempotencyKey: input.trackingId } : {}),
      signal: AbortSignal.timeout(EMAIL_PROVIDER_TIMEOUT_MS),
    } as CreateEmailRequestOptions;

    let result: SendEmailResult;
    try {
      const { data, error } = await this.client.emails.send(payload, requestOptions);
      result = error ? classifyResendError(error, idempotent) : acceptedSend(data?.id);
    } catch (error: unknown) {
      // The SDK turns fetch failures into `{ error }`; anything thrown here is unexpected.
      result = ambiguousSend(error instanceof Error ? error.message : "Unknown error", {
        idempotentRetry: idempotent,
      });
    }

    if (result.outcome === "accepted") {
      logger.info(
        { to: input.to, messageId: result.messageId, trackingId: input.trackingId },
        "Email sent successfully via Resend",
      );
    } else {
      logger.error(
        {
          to: input.to,
          error: result.error,
          outcome: result.outcome,
          statusCode: result.statusCode,
          trackingId: input.trackingId,
        },
        "Failed to send email via Resend",
      );
    }
    return result;
  }

  handleWebhook(rawBody: Buffer, headers: WebhookHeaders): WebhookResult {
    if (!this.webhookSecret) {
      logger.error(
        "Resend webhook secret not configured — rejecting webhook request",
      );
      return { ok: false, reason: "unconfigured" };
    }

    const id = getHeader(headers, "svix-id");
    const timestamp = getHeader(headers, "svix-timestamp");
    const signature = getHeader(headers, "svix-signature");
    if (!id || !timestamp || !signature) {
      return { ok: false, reason: "invalid_signature" };
    }

    let payload: WebhookEventPayload;
    try {
      // Svix verifies the signature AND timestamp freshness; throws on either.
      payload = this.client.webhooks.verify({
        payload: rawBody.toString("utf8"),
        headers: { id, timestamp, signature },
        webhookSecret: this.webhookSecret,
      });
    } catch (error) {
      logger.warn({ error }, "Invalid Resend webhook signature");
      return { ok: false, reason: "invalid_signature" };
    }

    const { events, logOnly } = normalizeResendEvents(payload);
    return { ok: true, events, logOnly };
  }
}

export function createResendProvider(): EmailProvider {
  const { apiKey, webhookSecret } = integrationsConfig().email.resend;
  return new ResendProvider({
    apiKey,
    webhookSecret,
    ...resolveEmailSender(),
  });
}
