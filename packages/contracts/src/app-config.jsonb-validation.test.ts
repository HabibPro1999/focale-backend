import { describe, expect, it } from "vitest";
import { ConfigError, parseAppConfig, resolveJsonbValidationMode } from "./app-config";

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

describe("JSONB_VALIDATION", () => {
  it("defaults to warn (typed JSON reads behave as before typing)", () => {
    expect(parseAppConfig(env()).JSONB_VALIDATION).toBe("warn");
    expect(parseAppConfig(env({ JSONB_VALIDATION: "  " })).JSONB_VALIDATION).toBe("warn");
  });

  it.each(["warn", "enforce"] as const)("accepts %s", (mode) => {
    expect(parseAppConfig(env({ JSONB_VALIDATION: mode })).JSONB_VALIDATION).toBe(mode);
  });

  it("rejects any other value at boot, naming the key only", () => {
    expect(() => parseAppConfig(env({ JSONB_VALIDATION: "strict" }))).toThrow(ConfigError);
    try {
      parseAppConfig(env({ JSONB_VALIDATION: "ENFORCE" }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(String((error as Error).message)).toContain("JSONB_VALIDATION");
      expect(String((error as Error).message)).not.toContain("ENFORCE");
    }
  });

  it("resolves from a bare environment for tools that never parse the whole config", () => {
    expect(resolveJsonbValidationMode({})).toBe("warn");
    expect(resolveJsonbValidationMode({ JSONB_VALIDATION: "" })).toBe("warn");
    expect(resolveJsonbValidationMode({ JSONB_VALIDATION: "enforce" })).toBe("enforce");
    expect(() => resolveJsonbValidationMode({ JSONB_VALIDATION: "yes" })).toThrow(
      "JSONB_VALIDATION must be one of: warn, enforce",
    );
  });
});
