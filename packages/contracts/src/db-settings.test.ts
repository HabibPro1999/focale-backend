import { describe, expect, it } from "vitest";
import { ConfigError, parseAppConfig } from "./app-config";
import { DB_SETTING_DEFAULTS, resolveDbRuntimeSettings } from "./db-settings";

function appEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://user:pass@localhost:26257/app",
    FIREBASE_PROJECT_ID: "demo-project",
    FIREBASE_STORAGE_BUCKET: "demo-bucket",
    ...overrides,
  };
}

describe("resolveDbRuntimeSettings", () => {
  it("applies the defaults (pool 20 in production, 5 otherwise)", () => {
    expect(resolveDbRuntimeSettings({ NODE_ENV: "production" })).toEqual({
      poolMax: 20,
      statementTimeoutMs: DB_SETTING_DEFAULTS.statementTimeoutMs,
      idleInTransactionTimeoutMs: DB_SETTING_DEFAULTS.idleInTransactionTimeoutMs,
      exportStatementTimeoutMs: DB_SETTING_DEFAULTS.exportStatementTimeoutMs,
    });
    expect(resolveDbRuntimeSettings({ NODE_ENV: "development" }).poolMax).toBe(5);
    expect(resolveDbRuntimeSettings({}).poolMax).toBe(5);
    // Empty strings (an unset Render variable) mean "use the default".
    expect(resolveDbRuntimeSettings({ DB_POOL_MAX: "", DB_STATEMENT_TIMEOUT_MS: " " })).toMatchObject({
      poolMax: 5,
      statementTimeoutMs: 60_000,
    });
  });

  it("accepts explicit values, including 0 to disable a timeout", () => {
    expect(
      resolveDbRuntimeSettings({
        NODE_ENV: "production",
        DB_POOL_MAX: " 40 ",
        DB_STATEMENT_TIMEOUT_MS: "0",
        DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: "1000",
        DB_EXPORT_STATEMENT_TIMEOUT_MS: "3600000",
      }),
    ).toEqual({
      poolMax: 40,
      statementTimeoutMs: 0,
      idleInTransactionTimeoutMs: 1000,
      exportStatementTimeoutMs: 3_600_000,
    });
  });

  it.each([
    ["DB_POOL_MAX", "0"],
    ["DB_POOL_MAX", "101"],
    ["DB_POOL_MAX", "abc"],
    ["DB_POOL_MAX", "1e1"],
    ["DB_POOL_MAX", "2.5"],
    ["DB_POOL_MAX", "-3"],
    ["DB_STATEMENT_TIMEOUT_MS", "999"],
    ["DB_STATEMENT_TIMEOUT_MS", "30s"],
    ["DB_STATEMENT_TIMEOUT_MS", "3600001"],
    ["DB_IDLE_IN_TRANSACTION_TIMEOUT_MS", "60"],
    ["DB_EXPORT_STATEMENT_TIMEOUT_MS", "-1"],
  ])("rejects %s=%s", (key, value) => {
    expect(() => resolveDbRuntimeSettings({ [key]: value })).toThrow(key);
  });
});

describe("parseAppConfig database settings", () => {
  it("exposes the same resolved values the db client uses", () => {
    const config = parseAppConfig(appEnv({ DB_POOL_MAX: "12", DB_STATEMENT_TIMEOUT_MS: "45000" }));
    expect(config.database).toEqual(
      resolveDbRuntimeSettings({ NODE_ENV: "test", DB_POOL_MAX: "12", DB_STATEMENT_TIMEOUT_MS: "45000" }),
    );
    expect(parseAppConfig(appEnv()).database.poolMax).toBe(5);
  });

  it("fails fast on invalid DB_* values", () => {
    expect(() => parseAppConfig(appEnv({ DB_POOL_MAX: "500" }))).toThrow(ConfigError);
    expect(() => parseAppConfig(appEnv({ DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: "5" }))).toThrow(
      /DB_IDLE_IN_TRANSACTION_TIMEOUT_MS/,
    );
  });
});
