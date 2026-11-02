import { describe, expect, it } from "vitest";
import * as contracts from "./index";
import { APP_ENV_SHAPE, ConfigError, integrationsConfigFromEnv, parseAppConfig } from "./app-config";

const requiredEnv = {
  DATABASE_URL: "postgresql://user:pass@localhost/app",
  FIREBASE_PROJECT_ID: "project",
  FIREBASE_STORAGE_BUCKET: "bucket",
};

describe("config public and lenient boundaries", () => {
  it("exposes the same public class, documented schema and parser functions through the barrel", () => {
    expect(contracts.ConfigError).toBe(ConfigError);
    expect(contracts.APP_ENV_SHAPE).toBe(APP_ENV_SHAPE);
    expect(contracts.parseAppConfig).toBe(parseAppConfig);
    expect(contracts.integrationsConfigFromEnv).toBe(integrationsConfigFromEnv);
    expect(() => integrationsConfigFromEnv({ EMAIL_PROVIDER: "invalid" })).toThrow(contracts.ConfigError);
  });

  it("reads the lenient production fallback without cross-key rules or unrelated fields", () => {
    const config = integrationsConfigFromEnv({
      NODE_ENV: "production",
      DATABASE_URL: "invalid",
      PORT: "invalid",
      CORS_ORIGIN: "invalid",
      TRUST_PROXY: "invalid",
      NETWORKING_WITHDRAWAL_ERASE_DAYS: "invalid",
    });
    expect(config.isProduction).toBe(true);
    expect(config.firebase.projectId).toBeUndefined();
    expect(config.firebase.storageBucket).toBeUndefined();
    expect(config.email.sendgrid.apiKey).toBeUndefined();
    expect(config.networking.tokenSecret).toBeUndefined();
    expect(config.publicFormsUrl).toBe("http://localhost:8080");
    expect(config.email.fromEmail).toBe("noreply@example.com");
  });

  it("requires the Firebase project for boot but treats blank as unset in the lenient path", () => {
    let bootError: unknown;
    try {
      parseAppConfig({ ...requiredEnv, FIREBASE_PROJECT_ID: "  " });
    } catch (caught) {
      bootError = caught;
    }
    expect(bootError).toBeInstanceOf(ConfigError);
    expect((bootError as ConfigError).issues.map((issue) => issue.key)).toContain("FIREBASE_PROJECT_ID");
    const blank = integrationsConfigFromEnv({ FIREBASE_PROJECT_ID: "  " });
    expect(blank.firebase.projectId).toBeUndefined();
    const padded = integrationsConfigFromEnv({ FIREBASE_PROJECT_ID: " project " });
    expect(padded.firebase.projectId).toBe(" project ");
  });

  it("orders lenient failures by the integration schema's key order, not source insertion order", () => {
    let error: unknown;
    try {
      integrationsConfigFromEnv({
        PUBLIC_FORMS_URL: "invalid",
        R2_PUBLIC_URL: "invalid",
        NETWORKING_EMBEDDING_BATCH_SIZE: "0",
        NETWORKING_KEYS: "invalid",
        SENDGRID_FROM_EMAIL: "invalid",
        EMAIL_PROVIDER: "invalid",
        FIREBASE_AUTH_LOOKUP_FALLBACK: "invalid",
        NODE_ENV: "invalid",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues.map((issue) => issue.key)).toEqual([
      "NODE_ENV",
      "FIREBASE_AUTH_LOOKUP_FALLBACK",
      "R2_PUBLIC_URL",
      "EMAIL_PROVIDER",
      "SENDGRID_FROM_EMAIL",
      "PUBLIC_FORMS_URL",
      "NETWORKING_KEYS",
      "NETWORKING_EMBEDDING_BATCH_SIZE",
    ]);
  });
});
