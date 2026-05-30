// =============================================================================
// EMAIL PROVIDER FACTORY
// Resolves the active provider from config (EMAIL_PROVIDER), memoized.
// =============================================================================

import { config } from "@config/app.config.js";
import type { EmailProvider } from "./email-provider.types.js";
import { createSendgridProvider } from "./sendgrid.provider.js";
import { createResendProvider } from "./resend.provider.js";

let cached: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (cached) return cached;
  cached =
    config.email.provider === "resend"
      ? createResendProvider()
      : createSendgridProvider();
  return cached;
}

/** Clear the memoized provider — used by tests that flip EMAIL_PROVIDER. */
export function resetEmailProviderCache(): void {
  cached = null;
}

export * from "./email-provider.types.js";
