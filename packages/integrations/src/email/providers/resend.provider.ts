// =============================================================================
// RESEND EMAIL PROVIDER
// Sends via the Resend API; verifies + normalizes Resend (Svix-signed) webhooks.
// =============================================================================

import {
  Resend,
  type CreateEmailOptions,
  type WebhookEventPayload,
} from "resend";
import { logger } from "../../logger";
import {
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
    case "email.sent":
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
      return { success: false, error: "Resend not configured" };
    }

    try {
      const { data, error } = await this.client.emails.send(
        buildResendPayload(input, this.from),
        // emailLog id is a natural idempotency key for queued sends.
        input.trackingId ? { idempotencyKey: input.trackingId } : undefined,
      );

      if (error) {
        logger.error(
          { to: input.to, error: error.message, trackingId: input.trackingId },
          "Failed to send email via Resend",
        );
        return { success: false, error: error.message || error.name };
      }

      logger.info(
        { to: input.to, messageId: data?.id, trackingId: input.trackingId },
        "Email sent successfully via Resend",
      );
      return { success: true, messageId: data?.id };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error(
        { to: input.to, error: message, trackingId: input.trackingId },
        "Failed to send email via Resend",
      );
      return { success: false, error: message };
    }
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
  return new ResendProvider({
    apiKey: process.env.RESEND_API_KEY,
    webhookSecret: process.env.RESEND_WEBHOOK_SECRET,
    ...resolveEmailSender(),
  });
}
