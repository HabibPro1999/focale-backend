import { describe, expect, it } from "vitest";
import { trustProxyHops } from "./app.factory";

describe("TRUST_PROXY", () => {
  it("fails fast in production when unset, so venue rate limits never key on a spoofable header", () => {
    expect(() => trustProxyHops({ NODE_ENV: "production" })).toThrow(/TRUST_PROXY must be set in production/);
    expect(() => trustProxyHops({ NODE_ENV: "production", TRUST_PROXY: " " })).toThrow(/TRUST_PROXY/);
  });
  it.each([["1", 1], ["2", 2], ["0", 0]])("trusts exactly %s hop(s)", (value, hops) => {
    expect(trustProxyHops({ NODE_ENV: "production", TRUST_PROXY: value })).toBe(hops);
  });
  it.each(["true", "-1", "1.5", "all"])("rejects a non-integer hop count %s", (value) => {
    expect(() => trustProxyHops({ NODE_ENV: "development", TRUST_PROXY: value })).toThrow(/non-negative integer/);
  });
  it("uses the socket address outside production when unset", () => {
    expect(trustProxyHops({ NODE_ENV: "development" })).toBe(false);
    expect(trustProxyHops({})).toBe(false);
  });
});

describe("unit-test environment", () => {
  it("replaces an inherited database URL with the local dummy URL", () => {
    expect(process.env.DATABASE_URL).toBe(
      "postgresql://test_user:test_password@localhost:5432/focale_unit_test",
    );
  });
});
