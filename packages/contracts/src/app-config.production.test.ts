import { describe, expect, it } from "vitest";
import {
  ConfigError,
  integrationsConfigFromEnv,
  parseAppConfig,
  validateAppEnv,
} from "./app-config";

const SERVICE_ACCOUNT = { type: "service_account", project_id: "demo-project" };

/** A complete, valid production environment (SendGrid, Firebase storage). */
function productionEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://user:pass@db.internal:26257/app",
    CORS_ORIGIN: "https://admin.example.com,https://forms.example.com",
    TRUST_PROXY: "10.0.0.0/24",
    ADMIN_APP_URL: "https://admin.example.com",
    PUBLIC_FORMS_URL: "https://forms.example.com",
    PUBLIC_LINK_ALLOWED_ORIGINS: "https://forms.example.com",
    FIREBASE_PROJECT_ID: "demo-project",
    FIREBASE_STORAGE_BUCKET: "demo-bucket",
    SENDGRID_API_KEY: "SG.key",
    EMAIL_FROM_EMAIL: "noreply@example.com",
    NETWORKING_TOKEN_SECRET: "s".repeat(32),
    ...overrides,
  };
}

function failingKeys(env: NodeJS.ProcessEnv): string[] {
  const result = validateAppEnv(env);
  return result.ok ? [] : result.issues.map((issue) => issue.key);
}

describe("production rules", () => {
  it("accepts a complete production environment", () => {
    const config = parseAppConfig(productionEnv());
    expect(config.isProduction).toBe(true);
    expect(config.http.trustProxy).toEqual(["10.0.0.0/24"]);
    expect(config.http.cors).toEqual({
      allowAnyOrigin: false,
      origins: ["https://admin.example.com", "https://forms.example.com"],
    });
    expect(config.publicFormsUrl).toBe("https://forms.example.com");
    expect(config.integrations.networking.tokenSecret).toBe("s".repeat(32));
  });

  it("requires the SendGrid API key when SendGrid is the provider (default)", () => {
    expect(failingKeys(productionEnv({ SENDGRID_API_KEY: undefined }))).toEqual(["SENDGRID_API_KEY"]);
    expect(failingKeys(productionEnv({ SENDGRID_API_KEY: "" }))).toEqual(["SENDGRID_API_KEY"]);
    // Not required when Resend is selected (Resend's own key is).
    expect(
      failingKeys(
        productionEnv({ SENDGRID_API_KEY: undefined, EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_x" }),
      ),
    ).toEqual([]);
    // Outside production the key stays optional.
    expect(failingKeys(productionEnv({ NODE_ENV: "test", SENDGRID_API_KEY: undefined }))).toEqual([]);
  });

  it("requires PUBLIC_FORMS_URL (no example.com fallback) and defaults it locally", () => {
    expect(failingKeys(productionEnv({ PUBLIC_FORMS_URL: undefined }))).toEqual(["PUBLIC_FORMS_URL"]);
    const local = parseAppConfig(productionEnv({ NODE_ENV: "development", PUBLIC_FORMS_URL: undefined }));
    expect(local.publicFormsUrl).toBe("http://localhost:8080");
  });

  it("requires the networking token secret unless networking is disabled", () => {
    expect(failingKeys(productionEnv({ NETWORKING_TOKEN_SECRET: undefined }))).toEqual([
      "NETWORKING_TOKEN_SECRET",
    ]);
    const disabled = parseAppConfig(
      productionEnv({ NETWORKING_TOKEN_SECRET: "s".repeat(32), NETWORKING_DISABLED: "true" }),
    );
    expect(disabled.networking.disabled).toBe(true);
    // Disabled networking never hands out the secret.
    expect(disabled.networking.tokenSecret).toBeUndefined();
    expect(
      failingKeys(productionEnv({ NETWORKING_TOKEN_SECRET: undefined, NETWORKING_DISABLED: "true" })),
    ).toEqual([]);
    expect(failingKeys(productionEnv({ NETWORKING_TOKEN_SECRET: "too-short" }))).toEqual([
      "NETWORKING_TOKEN_SECRET",
    ]);
  });

  it.each([
    ["*"],
    ["https://admin.example.com,*"],
    ["https://admin.example.com/app"],
    ["admin.example.com"],
    ["https://*.example.com"],
    ["ftp://admin.example.com"],
    [","],
  ])("rejects CORS_ORIGIN=%j in production", (value) => {
    expect(failingKeys(productionEnv({ CORS_ORIGIN: value }))).toEqual(["CORS_ORIGIN"]);
  });

  it("keeps `*` CORS for local development only and validates entries everywhere", () => {
    const dev = parseAppConfig(productionEnv({ NODE_ENV: "development", CORS_ORIGIN: "*" }));
    expect(dev.http.cors).toEqual({ allowAnyOrigin: true, origins: [] });
    expect(failingKeys(productionEnv({ NODE_ENV: "development", CORS_ORIGIN: "not-an-origin" }))).toEqual([
      "CORS_ORIGIN",
    ]);
    // A trailing slash is normalized to the browser's Origin form.
    expect(parseAppConfig(productionEnv({ CORS_ORIGIN: "https://Admin.Example.com/" })).http.cors.origins).toEqual([
      "https://admin.example.com",
    ]);
  });

  it("accepts FIREBASE_SERVICE_ACCOUNT as raw JSON or base64 JSON", () => {
    const raw = JSON.stringify(SERVICE_ACCOUNT);
    expect(failingKeys(productionEnv({ FIREBASE_SERVICE_ACCOUNT: raw }))).toEqual([]);
    expect(
      failingKeys(productionEnv({ FIREBASE_SERVICE_ACCOUNT: Buffer.from(raw).toString("base64") })),
    ).toEqual([]);
    expect(failingKeys(productionEnv({ FIREBASE_SERVICE_ACCOUNT: "{not json" }))).toEqual([
      "FIREBASE_SERVICE_ACCOUNT",
    ]);
    expect(
      failingKeys(productionEnv({ FIREBASE_SERVICE_ACCOUNT: Buffer.from("[1]").toString("base64") })),
    ).toEqual(["FIREBASE_SERVICE_ACCOUNT"]);
  });

  it("validates NETWORKING_EMAIL_SENDERS as a JSON object at boot", () => {
    expect(failingKeys(productionEnv({ NETWORKING_EMAIL_SENDERS: "{}" }))).toEqual([]);
    expect(failingKeys(productionEnv({ NETWORKING_EMAIL_SENDERS: "not json" }))).toEqual([
      "NETWORKING_EMAIL_SENDERS",
    ]);
  });

  it("validates the networking embedding worker bounds at boot", () => {
    expect(failingKeys(productionEnv({ NETWORKING_EMBEDDING_CONCURRENCY: "100" }))).toEqual([
      "NETWORKING_EMBEDDING_CONCURRENCY",
    ]);
    expect(failingKeys(productionEnv({ NETWORKING_EMBEDDING_BATCH_SIZE: "NaN" }))).toEqual([
      "NETWORKING_EMBEDDING_BATCH_SIZE",
    ]);
    expect(parseAppConfig(productionEnv()).networking.embedding).toMatchObject({
      batchSize: 16,
      batchesPerTick: 8,
      concurrency: 2,
      model: "text-embedding-3-small",
    });
  });

  it("reports every failing key in one pass, including rules on keys that parsed", () => {
    const keys = failingKeys(
      productionEnv({
        DATABASE_URL: "not a url",
        PORT: "http",
        SENDGRID_API_KEY: undefined,
        TRUST_PROXY: undefined,
        PUBLIC_FORMS_URL: undefined,
      }),
    );
    expect(keys.sort()).toEqual(
      ["DATABASE_URL", "PORT", "PUBLIC_FORMS_URL", "SENDGRID_API_KEY", "TRUST_PROXY"].sort(),
    );
  });

  it("still reports production rules when required keys are missing", () => {
    const keys = failingKeys({ NODE_ENV: "production" });
    expect(keys).toEqual(
      expect.arrayContaining([
        "DATABASE_URL",
        "FIREBASE_PROJECT_ID",
        "FIREBASE_STORAGE_BUCKET",
        "TRUST_PROXY",
        "PUBLIC_LINK_ALLOWED_ORIGINS",
        "SENDGRID_API_KEY",
        "EMAIL_FROM_EMAIL",
        "ADMIN_APP_URL",
        "PUBLIC_FORMS_URL",
        "NETWORKING_TOKEN_SECRET",
      ]),
    );
  });

  it("never echoes configured values in validation messages", () => {
    const secret = "SECRET-VALUE-9f3a";
    try {
      parseAppConfig(
        productionEnv({
          DATABASE_URL: `postgres-${secret}`,
          CORS_ORIGIN: `https://${secret}.example.com/path`,
          TRUST_PROXY: `${secret}.internal`,
          NETWORKING_TOKEN_SECRET: secret,
          EMAIL_PROVIDER: secret,
          FIREBASE_SERVICE_ACCOUNT: secret,
          NETWORKING_EMAIL_SENDERS: secret,
          PUBLIC_LINK_ALLOWED_ORIGINS: `${secret}`,
          ABSTRACTS_RATE_LIMIT_WINDOW: secret,
          EMAIL_FROM_EMAIL: secret,
          PORT: secret,
        }),
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.length).toBeGreaterThanOrEqual(10);
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });
});

describe("integrationsConfigFromEnv (unconfigured fallback)", () => {
  it("builds the integrations slice without requiring app-only keys", () => {
    const slice = integrationsConfigFromEnv({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_x" });
    expect(slice.email.provider).toBe("resend");
    expect(slice.email.resend.apiKey).toBe("re_x");
    expect(slice.firebase.projectId).toBeUndefined();
    expect(slice.publicFormsUrl).toBe("http://localhost:8080");
    expect(slice.networking.embedding.batchSize).toBe(16);
  });

  it("treats blank values as unset", () => {
    const slice = integrationsConfigFromEnv({
      FIREBASE_PROJECT_ID: "",
      NETWORKING_EMBEDDING_MODEL: "",
      NETWORKING_TOKEN_SECRET: " ",
    });
    expect(slice.firebase.projectId).toBeUndefined();
    expect(slice.networking.embedding.model).toBe("text-embedding-3-small");
    expect(slice.networking.tokenSecret).toBeUndefined();
  });

  it("matches the slice parseAppConfig hands to configureIntegrations", () => {
    const env = productionEnv({ NODE_ENV: "test" });
    expect(integrationsConfigFromEnv(env)).toEqual(parseAppConfig(env).integrations);
  });
});
