import { describe, expect, it } from "vitest";
import { ConfigError, parseAppConfig } from "./app-config";

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://user:pass@localhost:26257/app",
    FIREBASE_PROJECT_ID: "demo-project",
    FIREBASE_STORAGE_BUCKET: "demo-bucket",
    STORAGE_PROVIDER: "firebase",
    ...overrides,
  };
}

describe("MIGRATIONS_CHECK", () => {
  it("defaults to warn until the production ledger is adopted", () => {
    expect(parseAppConfig(env()).MIGRATIONS_CHECK).toBe("warn");
  });

  it.each(["enforce", "warn", "off"] as const)("accepts %s", (mode) => {
    expect(parseAppConfig(env({ MIGRATIONS_CHECK: mode })).MIGRATIONS_CHECK).toBe(mode);
  });

  it("rejects any other value at boot", () => {
    expect(() => parseAppConfig(env({ MIGRATIONS_CHECK: "strict" }))).toThrow(ConfigError);
    expect(() => parseAppConfig(env({ MIGRATIONS_CHECK: "ENFORCE" }))).toThrow(ConfigError);
  });
});
