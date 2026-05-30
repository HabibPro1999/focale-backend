// =============================================================================
// SENDGRID EMAIL PROVIDER
// Sends via the SendGrid API; verifies + normalizes SendGrid event webhooks.
// =============================================================================

import sgMail from "@sendgrid/mail";
import { EventWebhook, EventWebhookHeader } from "@sendgrid/eventwebhook";
import { logger } from "@shared/utils/logger.js";
import { config } from "@config/app.config.js";
import {
  getHeader,
  stripHtml,
  type EmailProvider,
  type NormalizedEventType,
  type NormalizedWebhookEvent,
  type LogOnlyWebhookEvent,
  type SendEmailInput,
  type SendEmailResult,
  type WebhookHeaders,
  type WebhookResult,
} from "./email-provider.types.js";

// Webhook signature freshness window — reject replays / stale deliveries.
const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

// SendGrid event names already match our normalized vocabulary 1:1.
const HANDLED_EVENTS: Record<string, NormalizedEventType> = {
  delivered: "delivered",
  open: "open",
  click: "click",
  bounce: "bounce",
  dropped: "dropped",
  blocked: "blocked",
  spam_report: "spam_report",
  unsubscribe: "unsubscribe",
};

// Acknowledged but not mapped to a status change (e.g. transient deferral).
const LOG_ONLY_EVENTS = new Set(["deferred"]);

/**
 * Map a parsed SendGrid webhook batch onto our normalized vocabulary.
 * Pure (no crypto / config) so it can be unit-tested directly.
 */
export function mapSendgridEvents(parsed: unknown): {
  events: NormalizedWebhookEvent[];
  logOnly: LogOnlyWebhookEvent[];
} {
  const events: NormalizedWebhookEvent[] = [];
  const logOnly: LogOnlyWebhookEvent[] = [];

  if (!Array.isArray(parsed)) {
    logger.warn(
      { bodyType: typeof parsed },
      "Invalid SendGrid webhook payload: expected array",
    );
    return { events, logOnly };
  }

  for (const raw of parsed as Array<Record<string, unknown>>) {
    const eventName = String(raw.event || "");
    // customArgs are flattened onto the event object by SendGrid.
    const emailLogId = raw.emailLogId as string | undefined;
    if (!emailLogId) continue;

    const reason = raw.reason as string | undefined;

    if (LOG_ONLY_EVENTS.has(eventName)) {
      logOnly.push({ type: eventName, emailLogId, reason });
      continue;
    }

    const type = HANDLED_EVENTS[eventName];
    if (!type) continue;

    events.push({
      emailLogId,
      type,
      metadata: { url: raw.url as string | undefined, reason },
    });
  }

  return { events, logOnly };
}

export interface SendgridProviderOptions {
  apiKey?: string;
  webhookPublicKey?: string;
  fromEmail: string;
  fromName: string;
}

export class SendgridProvider implements EmailProvider {
  readonly name = "sendgrid" as const;

  private readonly apiKey?: string;
  private readonly webhookPublicKey?: string;
  private readonly fromEmail: string;
  private readonly fromName: string;
  private keySet = false;

  constructor(opts: SendgridProviderOptions) {
    this.apiKey = opts.apiKey;
    this.webhookPublicKey = opts.webhookPublicKey;
    this.fromEmail = opts.fromEmail;
    this.fromName = opts.fromName;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  private ensureApiKey(): void {
    if (this.apiKey && !this.keySet) {
      sgMail.setApiKey(this.apiKey);
      this.keySet = true;
    }
  }

  async sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
    if (!this.apiKey) {
      logger.warn("SendGrid API key not configured, skipping email send");
      return { success: false, error: "SendGrid not configured" };
    }
    this.ensureApiKey();

    try {
      const msg: sgMail.MailDataRequired = {
        to: input.toName ? { email: input.to, name: input.toName } : input.to,
        from: { email: this.fromEmail, name: input.fromName || this.fromName },
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
        ...(input.attachments?.length && { attachments: input.attachments }),
      };

      const [response] = await sgMail.send(msg);
      const messageId = response.headers["x-message-id"] as string | undefined;

      logger.info(
        { to: input.to, messageId, trackingId: input.trackingId },
        "Email sent successfully via SendGrid",
      );

      return { success: true, messageId: messageId || undefined };
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

      return { success: false, error: errorMessage };
    }
  }

  handleWebhook(rawBody: Buffer, headers: WebhookHeaders): WebhookResult {
    if (!this.webhookPublicKey) {
      logger.error(
        "SendGrid webhook public key not configured — rejecting webhook request",
      );
      return { ok: false, reason: "unconfigured" };
    }

    const signature = getHeader(headers, EventWebhookHeader.SIGNATURE());
    const timestamp = getHeader(headers, EventWebhookHeader.TIMESTAMP());

    // Staleness check happens before the (more expensive) signature verification.
    const timestampMs = Number(timestamp) * 1000;
    if (
      !Number.isFinite(timestampMs) ||
      Math.abs(Date.now() - timestampMs) > WEBHOOK_TIMESTAMP_TOLERANCE_MS
    ) {
      return { ok: false, reason: "stale" };
    }

    if (!signature || !this.verifySignature(rawBody, signature, timestamp!)) {
      return { ok: false, reason: "invalid_signature" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString());
    } catch {
      return { ok: false, reason: "bad_payload" };
    }

    return { ok: true, ...mapSendgridEvents(parsed) };
  }

  private verifySignature(
    payload: Buffer,
    signature: string,
    timestamp: string,
  ): boolean {
    try {
      const eventWebhook = new EventWebhook();
      const ecPublicKey = eventWebhook.convertPublicKeyToECDSA(
        this.webhookPublicKey!,
      );
      const isValid = eventWebhook.verifySignature(
        ecPublicKey,
        payload,
        signature,
        timestamp,
      );
      if (!isValid) logger.warn("Invalid SendGrid webhook signature");
      return isValid;
    } catch (error) {
      logger.error({ error }, "Failed to verify SendGrid webhook signature");
      return false;
    }
  }
}

export function createSendgridProvider(): EmailProvider {
  return new SendgridProvider({
    apiKey: config.email.sendgrid.apiKey,
    webhookPublicKey: config.email.sendgrid.webhookPublicKey,
    fromEmail: config.email.fromEmail,
    fromName: config.email.fromName,
  });
}
