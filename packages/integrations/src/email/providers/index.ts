// =============================================================================
// EMAIL PROVIDER FACTORY
// Resolves the active provider from config (EMAIL_PROVIDER), memoized.
// =============================================================================

import type { EmailProvider } from "./email-provider.types";
import { createSendgridProvider } from "./sendgrid.provider";
import { createResendProvider } from "./resend.provider";
import { integrationsConfig } from "../../config";

let cached: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (cached) return cached;
  cached =
    integrationsConfig().email.provider === "resend"
      ? createResendProvider()
      : createSendgridProvider();
  return cached;
}

/** Clear the memoized provider — used by tests that flip EMAIL_PROVIDER. */
export function resetEmailProviderCache(): void {
  cached = null;
}

export * from "./email-provider.types";
export {
  SendgridProvider,
  classifySendgridError,
  createSendgridProvider,
  mapSendgridEvents,
  type SendgridProviderOptions,
} from "./sendgrid.provider";
export {
  ResendProvider,
  classifyResendError,
  createResendProvider,
  buildResendPayload,
  normalizeResendEvents,
  sanitizeTagValue,
  type ResendFrom,
  type ResendSendError,
  type ResendProviderOptions,
} from "./resend.provider";

export { getNetworkingEmailSender, networkingEmailSenderStatus } from "./networking-sender";
