// =============================================================================
// EMAIL PROVIDER FACTORY
// Resolves the active provider from env (EMAIL_PROVIDER), memoized.
// =============================================================================

import type { EmailProvider } from "./email-provider.types";
import { createSendgridProvider } from "./sendgrid.provider";
import { createResendProvider } from "./resend.provider";

let cached: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (cached) return cached;
  cached =
    process.env.EMAIL_PROVIDER === "resend"
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
  createSendgridProvider,
  mapSendgridEvents,
  type SendgridProviderOptions,
} from "./sendgrid.provider";
export {
  ResendProvider,
  createResendProvider,
  buildResendPayload,
  normalizeResendEvents,
  sanitizeTagValue,
  type ResendFrom,
  type ResendProviderOptions,
} from "./resend.provider";
