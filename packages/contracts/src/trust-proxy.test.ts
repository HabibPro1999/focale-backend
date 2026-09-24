import { describe, expect, it } from "vitest";
import { ConfigError, parseAppConfig } from "./app-config";
import { resolveTrustProxy } from "./trust-proxy";

// Moved from apps/api/src/app.factory.test.ts (0.2): TRUST_PROXY is now part of
// the config schema. The fail-closed semantics are unchanged.

function env(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://user:pass@localhost:26257/app",
    FIREBASE_PROJECT_ID: "demo-project",
    FIREBASE_STORAGE_BUCKET: "demo-bucket",
    ...overrides,
  };
}

/** A production env that satisfies every other production rule. */
function production(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env({
    NODE_ENV: "production",
    ADMIN_APP_URL: "https://admin.example.com",
    CORS_ORIGIN: "https://admin.example.com",
    PUBLIC_FORMS_URL: "https://forms.example.com",
    PUBLIC_LINK_ALLOWED_ORIGINS: "https://forms.example.com",
    SENDGRID_API_KEY: "SG.key",
    EMAIL_FROM_EMAIL: "noreply@example.com",
    NETWORKING_TOKEN_SECRET: "s".repeat(32),
    ...overrides,
  });
}

function trustProxy(source: NodeJS.ProcessEnv) {
  return parseAppConfig(source).http.trustProxy;
}

describe("TRUST_PROXY", () => {
  it("requires an explicit proxy configuration in production", () => {
    expect(() => trustProxy(production({}))).toThrow(/TRUST_PROXY is required in production/);
    expect(() => trustProxy(production({ TRUST_PROXY: " " }))).toThrow(
      /actual proxy peer addresses/,
    );
  });

  it.each([
    ["127.0.0.1", ["127.0.0.1"]],
    ["10.0.0.0/24, 2001:db8::1", ["10.0.0.0/24", "2001:db8::1"]],
    ["10.0.0.1,10.0.0.1", ["10.0.0.1"]],
  ])("parses explicit proxy addresses %s", (value, addresses) => {
    expect(trustProxy(production({ TRUST_PROXY: value }))).toEqual(addresses);
  });

  it.each([
    "0",
    "1",
    "2",
    "true",
    "TRUE",
    "*",
    "loopback",
    "0.0.0.0/0",
    "::/0",
    "10.0.0.0/33",
    "2001:db8::/129",
    "not-an-ip",
    "127.0.0.1,",
    "127.0.0.1,,192.0.2.1",
    "10.0.0.1/24/8",
    "10.0.0.1/abc",
  ])("rejects unsafe or invalid proxy trust value %s in every environment", (value) => {
    for (const source of [production({ TRUST_PROXY: value }), env({ TRUST_PROXY: value })]) {
      expect(() => trustProxy(source)).toThrow(ConfigError);
      expect(() => trustProxy(source)).toThrow(/TRUST_PROXY/);
    }
    expect(() => resolveTrustProxy(value)).toThrow(/TRUST_PROXY/);
  });

  it("does not echo the rejected value", () => {
    expect(() => trustProxy(production({ TRUST_PROXY: "proxy.internal.example" }))).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("proxy.internal.example") }),
    );
  });

  it("allows an explicit no-proxy production mode", () => {
    expect(trustProxy(production({ TRUST_PROXY: "false" }))).toBe(false);
    expect(trustProxy(production({ TRUST_PROXY: "FALSE" }))).toBe(false);
  });

  it.each(["development", "test"])("uses the socket address in %s when unset", (NODE_ENV) => {
    expect(trustProxy(env({ NODE_ENV }))).toBe(false);
    expect(trustProxy(env({ NODE_ENV, TRUST_PROXY: "" }))).toBe(false);
  });

  it("defaults to no trusted proxies when NODE_ENV is unset", () => {
    expect(trustProxy(env({ NODE_ENV: undefined }))).toBe(false);
    expect(resolveTrustProxy(undefined)).toBe(false);
  });
});
