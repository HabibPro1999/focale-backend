import { afterEach, describe, expect, it, vi } from "vitest";
import { integrationsConfigFromEnv } from "@app/contracts";
import {
  configureIntegrations,
  integrationsConfig,
  networkingConfig,
  resetIntegrationsConfig,
} from "./config";
import { buildRegistrationSelfLinks } from "./email/rendering/context";

afterEach(() => {
  resetIntegrationsConfig();
  vi.unstubAllEnvs();
});

describe("integrations config", () => {
  it("reads the environment on each call until configured", () => {
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    expect(integrationsConfig().email.provider).toBe("resend");
    vi.stubEnv("EMAIL_PROVIDER", "sendgrid");
    expect(integrationsConfig().email.provider).toBe("sendgrid");
  });

  it("uses the configured slice once the app hands it over, ignoring the environment", () => {
    const slice = integrationsConfigFromEnv({
      PUBLIC_FORMS_URL: "https://forms.example.com",
      NETWORKING_TOKEN_SECRET: "s".repeat(32),
    });
    configureIntegrations(slice);
    vi.stubEnv("PUBLIC_FORMS_URL", "https://other.example.com");
    vi.stubEnv("NETWORKING_TOKEN_SECRET", "t".repeat(32));

    expect(integrationsConfig()).toBe(slice);
    expect(networkingConfig().tokenSecret).toBe("s".repeat(32));
    expect(
      buildRegistrationSelfLinks({
        registrationId: "r1",
        eventSlug: "summit",
        editToken: "tok",
        linkBaseUrl: null,
      }).registrationLink,
    ).toBe("https://forms.example.com/summit/registration/r1/tok");
  });
});
