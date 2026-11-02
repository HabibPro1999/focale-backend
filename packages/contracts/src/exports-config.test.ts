import { describe, expect, it } from "vitest";
import { ConfigError, parseAppConfig } from "./app-config";

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://user:pass@localhost:26257/app",
    FIREBASE_PROJECT_ID: "demo-project",
    FIREBASE_STORAGE_BUCKET: "demo-bucket",
    ...overrides,
  };
}

describe("export admission config (3.7)", () => {
  it("defaults to 2 running exports and 4 queued", () => {
    expect(parseAppConfig(env()).exports).toEqual({ maxConcurrency: 2, maxQueued: 4 });
    expect(parseAppConfig(env({ EXPORT_MAX_CONCURRENCY: "", EXPORT_MAX_QUEUED: " " })).exports).toEqual({
      maxConcurrency: 2,
      maxQueued: 4,
    });
  });

  it("accepts 1-16 running and 0-64 queued", () => {
    expect(parseAppConfig(env({ EXPORT_MAX_CONCURRENCY: "16", EXPORT_MAX_QUEUED: "0" })).exports).toEqual({
      maxConcurrency: 16,
      maxQueued: 0,
    });
  });

  it.each([
    ["EXPORT_MAX_CONCURRENCY", "0"],
    ["EXPORT_MAX_CONCURRENCY", "17"],
    ["EXPORT_MAX_CONCURRENCY", "2.5"],
    ["EXPORT_MAX_QUEUED", "-1"],
    ["EXPORT_MAX_QUEUED", "65"],
    ["EXPORT_MAX_QUEUED", "many"],
  ])("rejects %s=%s", (key, value) => {
    expect(() => parseAppConfig(env({ [key]: value }))).toThrow(ConfigError);
    try {
      parseAppConfig(env({ [key]: value }));
    } catch (err) {
      expect((err as ConfigError).issues.map((issue) => issue.key)).toContain(key);
    }
  });
});
