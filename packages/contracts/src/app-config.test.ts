import { describe, expect, it } from "vitest";
import { ConfigError, parseAppConfig } from "./app-config";

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PORT: "3000",
    DATABASE_URL: "postgresql://user:pass@localhost:26257/app",
    CORS_ORIGIN: "http://localhost:8080",
    FIREBASE_PROJECT_ID: "demo-project",
    FIREBASE_STORAGE_BUCKET: "demo-bucket",
    STORAGE_PROVIDER: "firebase",
    ...overrides,
  };
}

describe("parseAppConfig", () => {
  it("parses the firebase storage configuration", () => {
    const config = parseAppConfig(baseEnv());

    expect(config.storage.provider).toBe("firebase");
    expect(config.firebase.storageBucket).toBe("demo-bucket");
    expect(config.email.provider).toBe("sendgrid");
    expect(config.email.fromEmail).toBe("noreply@example.com");
  });

  it("parses configurable abstract public rate limits", () => {
    const config = parseAppConfig(
      baseEnv({
        ABSTRACTS_SUBMIT_RATE_LIMIT_MAX: "250",
        ABSTRACTS_EDIT_RATE_LIMIT_MAX: "40",
        ABSTRACTS_READ_RATE_LIMIT_MAX: "500",
        ABSTRACTS_RATE_LIMIT_WINDOW: "2 minutes",
      }),
    );

    expect(config.security.publicAbstracts).toEqual({
      submitMax: 250,
      editMax: 40,
      readMax: 500,
      windowMs: 120_000,
    });
  });

  it("rejects an unparseable abstracts rate-limit window instead of silently using 60 s", () => {
    expect(() => parseAppConfig(baseEnv({ ABSTRACTS_RATE_LIMIT_WINDOW: "fortnight" }))).toThrow(
      "ABSTRACTS_RATE_LIMIT_WINDOW",
    );
    expect(parseAppConfig(baseEnv({ ABSTRACTS_RATE_LIMIT_WINDOW: "90000" })).security.publicAbstracts.windowMs).toBe(90_000);
  });

  it("parses and normalizes the public link origin allow-list", () => {
    const config = parseAppConfig(
      baseEnv({
        PUBLIC_LINK_ALLOWED_ORIGINS:
          " https://events.example.com/,http://localhost:8080 ",
      }),
    );

    expect(config.publicLinkAllowedOrigins).toEqual([
      "https://events.example.com",
      "http://localhost:8080",
    ]);
  });

  it("requires a firebase bucket when firebase storage is selected", () => {
    const env = baseEnv({ FIREBASE_STORAGE_BUCKET: undefined });

    expect(() => parseAppConfig(env)).toThrow(ConfigError);
    expect(() => parseAppConfig(env)).toThrow("FIREBASE_STORAGE_BUCKET required");
  });

  it("requires complete R2 credentials when R2 storage is selected", () => {
    const env = baseEnv({
      STORAGE_PROVIDER: "r2",
      FIREBASE_STORAGE_BUCKET: undefined,
      R2_ACCOUNT_ID: "account-id",
    });

    expect(() => parseAppConfig(env)).toThrow(ConfigError);
    expect(() => parseAppConfig(env)).toThrow(
      "R2 credentials required when STORAGE_PROVIDER=r2",
    );
  });

  it("parses complete R2 configuration", () => {
    const config = parseAppConfig(
      baseEnv({
        STORAGE_PROVIDER: "r2",
        FIREBASE_STORAGE_BUCKET: undefined,
        R2_ACCOUNT_ID: "account-id",
        R2_ACCESS_KEY_ID: "access-key",
        R2_SECRET_ACCESS_KEY: "secret-key",
        R2_BUCKET: "bucket",
        R2_PUBLIC_URL: "https://cdn.example.com",
      }),
    );

    expect(config.storage.provider).toBe("r2");
    expect(config.r2.bucket).toBe("bucket");
  });

  it("requires an explicit production sender when SendGrid is enabled", () => {
    const env = baseEnv({
      NODE_ENV: "production",
      ADMIN_APP_URL: "https://admin.example.com",
      SENDGRID_API_KEY: "sendgrid-key",
    });

    expect(() => parseAppConfig(env)).toThrow(ConfigError);
    expect(() => parseAppConfig(env)).toThrow(
      "A sender email (EMAIL_FROM_EMAIL or SENDGRID_FROM_EMAIL) is required in production",
    );
  });

  it("requires a Resend API key in production when EMAIL_PROVIDER=resend", () => {
    const env = baseEnv({
      NODE_ENV: "production",
      ADMIN_APP_URL: "https://admin.example.com",
      EMAIL_PROVIDER: "resend",
      EMAIL_FROM_EMAIL: "noreply@example.com",
    });

    expect(() => parseAppConfig(env)).toThrow(ConfigError);
    expect(() => parseAppConfig(env)).toThrow(
      "RESEND_API_KEY is required in production when EMAIL_PROVIDER=resend",
    );
  });

  it("forbids the localhost ADMIN_APP_URL default in production", () => {
    const env = baseEnv({ NODE_ENV: "production" });

    expect(() => parseAppConfig(env)).toThrow(ConfigError);
    expect(() => parseAppConfig(env)).toThrow(
      "ADMIN_APP_URL must be set to the deployed admin origin in production (default localhost:8080 not allowed)",
    );
  });

  it("requires valid public link origins in production", () => {
    expect(() =>
      parseAppConfig(
        baseEnv({
          NODE_ENV: "production",
          ADMIN_APP_URL: "https://admin.example.com",
        }),
      ),
    ).toThrow("PUBLIC_LINK_ALLOWED_ORIGINS");

    expect(() =>
      parseAppConfig(
        baseEnv({
          NODE_ENV: "production",
          ADMIN_APP_URL: "https://admin.example.com",
          PUBLIC_LINK_ALLOWED_ORIGINS: "https://events.example.com/path",
        }),
      ),
    ).toThrow("PUBLIC_LINK_ALLOWED_ORIGINS");
  });

  it("accepts a complete Resend production configuration", () => {
    const config = parseAppConfig(
      baseEnv({
        NODE_ENV: "production",
        ADMIN_APP_URL: "https://admin.example.com",
        CORS_ORIGIN: "https://admin.example.com",
        TRUST_PROXY: "10.0.0.0/24",
        PUBLIC_FORMS_URL: "https://events.example.com",
        NETWORKING_TOKEN_SECRET: "n".repeat(32),
        EMAIL_PROVIDER: "resend",
        RESEND_API_KEY: "re_test",
        RESEND_WEBHOOK_SECRET: "whsec_test",
        EMAIL_FROM_EMAIL: "noreply@example.com",
        EMAIL_FROM_NAME: "Focale",
        PUBLIC_LINK_ALLOWED_ORIGINS: "https://events.example.com",
      }),
    );

    expect(config.email.provider).toBe("resend");
    expect(config.email.resend.apiKey).toBe("re_test");
    expect(config.email.fromEmail).toBe("noreply@example.com");
    expect(config.email.fromName).toBe("Focale");
  });

  it("defaults logLevel per NODE_ENV and reads the RUN_WORKERS kill switch", () => {
    expect(parseAppConfig(baseEnv()).logLevel).toBe("info");
    expect(parseAppConfig(baseEnv({ NODE_ENV: "development" })).logLevel).toBe(
      "debug",
    );
    expect(parseAppConfig(baseEnv({ LOG_LEVEL: "warn" })).logLevel).toBe("warn");
    expect(parseAppConfig(baseEnv()).runWorkers).toBe(true);
    expect(parseAppConfig(baseEnv({ RUN_WORKERS: "false" })).runWorkers).toBe(
      false,
    );
  });
  it("defaults invite links to seven days and accepts an override", () => {
    expect(parseAppConfig(baseEnv()).security.committeeInvite.tokenTtlDays).toBe(7);
    expect(parseAppConfig(baseEnv({ COMMITTEE_INVITE_TOKEN_TTL_DAYS: "14" })).security.committeeInvite.tokenTtlDays).toBe(14);
    expect(() => parseAppConfig(baseEnv({ COMMITTEE_INVITE_TOKEN_TTL_DAYS: "0" }))).toThrow(ConfigError);
  });

  it("keeps the Firebase lookup fallback off with no built-in web API key", () => {
    const config = parseAppConfig(baseEnv());

    expect(config.firebase.authLookupFallback).toBe(false);
    expect(config.firebase.webApiKey).toBeUndefined();
    expect(
      parseAppConfig(baseEnv({ FIREBASE_WEB_API_KEY: "" })).firebase.webApiKey,
    ).toBeUndefined();
  });

  it("enables the Firebase lookup fallback only with a web API key", () => {
    const config = parseAppConfig(
      baseEnv({
        FIREBASE_AUTH_LOOKUP_FALLBACK: "true",
        FIREBASE_WEB_API_KEY: "web-key",
      }),
    );

    expect(config.firebase.authLookupFallback).toBe(true);
    expect(config.firebase.webApiKey).toBe("web-key");
  });

  it.each([undefined, ""])(
    "fails at boot when the lookup fallback is on without a web API key (%j)",
    (key) => {
      const env = baseEnv({
        FIREBASE_AUTH_LOOKUP_FALLBACK: "true",
        FIREBASE_WEB_API_KEY: key,
      });

      expect(() => parseAppConfig(env)).toThrow(ConfigError);
      expect(() => parseAppConfig(env)).toThrow(
        "FIREBASE_WEB_API_KEY is required when FIREBASE_AUTH_LOOKUP_FALLBACK=true",
      );
    },
  );

  it("rejects a non-boolean lookup fallback flag", () => {
    expect(() =>
      parseAppConfig(baseEnv({ FIREBASE_AUTH_LOOKUP_FALLBACK: "yes" })),
    ).toThrow(ConfigError);
  });
});
