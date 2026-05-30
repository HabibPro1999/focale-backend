// =============================================================================
// EMAIL SENDER (provider-agnostic facade)
// Delegates to the configured provider (SendGrid / Resend). This is the single
// surface the rest of the app imports for sending and for the webhook handler.
// =============================================================================

import { getEmailProvider } from "./providers/index.js";
import type { SendEmailInput, SendEmailResult } from "./providers/index.js";

export type {
  EmailAttachment,
  SendEmailInput,
  SendEmailResult,
  WebhookResult,
  NormalizedWebhookEvent,
} from "./providers/index.js";

/**
 * Send a single email via the active provider.
 * Returns `{ success:false }` (never throws) when the provider is unconfigured
 * or the send fails — the queue treats that as a retryable failure.
 */
export async function sendEmail(
  input: SendEmailInput,
): Promise<SendEmailResult> {
  return getEmailProvider().sendEmail(input);
}
