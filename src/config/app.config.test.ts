import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "./app.config.js";

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

describe("parseConfig", () => {
  it("parses the firebase storage configuration", () => {
    const config = parseConfig(baseEnv());

    expect(config.storage.provider).toBe("firebase");
    expect(config.firebase.storageBucket).toBe("demo-bucket");
    expect(config.sendgrid.fromEmail).toBe("noreply@example.com");
  });

  it("requires a firebase bucket when firebase storage is selected", () => {
    const env = baseEnv({ FIREBASE_STORAGE_BUCKET: undefined });

    expect(() => parseConfig(env)).toThrow(ConfigError);
    expect(() => parseConfig(env)).toThrow("FIREBASE_STORAGE_BUCKET required");
  });

  it("requires complete R2 credentials when R2 storage is selected", () => {
    const env = baseEnv({
      STORAGE_PROVIDER: "r2",
      FIREBASE_STORAGE_BUCKET: undefined,
      R2_ACCOUNT_ID: "account-id",
    });

    expect(() => parseConfig(env)).toThrow(ConfigError);
    expect(() => parseConfig(env)).toThrow(
      "R2 credentials required when STORAGE_PROVIDER=r2",
    );
  });

  it("parses complete R2 configuration", () => {
    const config = parseConfig(
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
      SENDGRID_API_KEY: "sendgrid-key",
    });

    expect(() => parseConfig(env)).toThrow(ConfigError);
    expect(() => parseConfig(env)).toThrow(
      "SENDGRID_FROM_EMAIL required in production",
    );
  });
});
