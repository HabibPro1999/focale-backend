import { describe, expect, it } from "vitest";
import { parseNetworkingKeys } from "./networking-keys";
import { validateAppEnv } from "./app-config";

const key = (n: number) => `${n}`.repeat(32);

describe("NETWORKING_KEYS", () => {
  it("parses kid:key entries, the first current, with recovery-only retired keys", () => {
    expect(parseNetworkingKeys(` k2:${key(2)} , k1:${key(1)}:recovery,legacy:${key(0)}:recovery `)).toEqual([
      { kid: "k2", secret: key(2), recoveryOnly: false },
      { kid: "k1", secret: key(1), recoveryOnly: true },
      { kid: "legacy", secret: key(0), recoveryOnly: true },
    ]);
  });
  it.each([
    ["", "at least one"],
    [`K1:${key(1)}`, "kid must be"],
    [`k1:short`, "at least 32"],
    [`k1:${key(1)},k1:${key(2)}`, "listed twice"],
    [`k1:${key(1)}:retired`, "kid:key:recovery"],
    [`k1:${key(1)}:recovery`, "first (current) key"],
  ])("rejects %s", (value, message) => {
    expect(() => parseNetworkingKeys(value)).toThrow(message);
  });
});

describe("keyring configuration at boot", () => {
  const base = { NODE_ENV: "test", DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/focale_unit_test" };
  // Only the networking keys: the minimal test environment misses unrelated keys.
  const issues = (env: Record<string, string>) => {
    const result = validateAppEnv({ ...base, ...env });
    return result.ok ? [] : result.issues.filter((issue) => issue.key.startsWith("NETWORKING_"));
  };
  it("rejects a malformed NETWORKING_KEYS and a legacy kid next to NETWORKING_TOKEN_SECRET", () => {
    expect(issues({ NETWORKING_KEYS: "k1:short" })).toEqual([expect.objectContaining({ key: "NETWORKING_KEYS" })]);
    expect(issues({ NETWORKING_KEYS: `legacy:${key(0)}`, NETWORKING_TOKEN_SECRET: key(9) }))
      .toEqual([expect.objectContaining({ key: "NETWORKING_KEYS", message: expect.stringContaining("only with it unset") })]);
    expect(issues({ NETWORKING_KEYS: `legacy:${key(0)}` })).toEqual([]);
    expect(issues({ NETWORKING_KEYRING_WRITE_V1: "yes" })).toEqual([expect.objectContaining({ key: "NETWORKING_KEYRING_WRITE_V1" })]);
  });
  it("requires NETWORKING_TOKEN_SECRET or NETWORKING_KEYS in production unless networking is disabled", () => {
    const networkingIssue = (env: Record<string, string>) =>
      issues({ NODE_ENV: "production", ...env }).filter((issue) => issue.key === "NETWORKING_TOKEN_SECRET");
    expect(networkingIssue({})).toEqual([
      expect.objectContaining({ message: "NETWORKING_TOKEN_SECRET or NETWORKING_KEYS is required in production unless NETWORKING_DISABLED=true" }),
    ]);
    expect(networkingIssue({ NETWORKING_KEYS: `k1:${key(1)}` })).toEqual([]);
    expect(networkingIssue({ NETWORKING_TOKEN_SECRET: key(1) })).toEqual([]);
    expect(networkingIssue({ NETWORKING_DISABLED: "true" })).toEqual([]);
  });
  it("never echoes key material in NETWORKING_KEYS errors", () => {
    for (const value of ["k1:SECRET-VALUE-short", "K1:SECRET-VALUE-9f3a-long-enough-for-a-key-000", `k1:SECRET-VALUE-9f3a-long-enough-for-a-key-000:bad`])
      for (const issue of issues({ NETWORKING_KEYS: value })) expect(issue.message).not.toContain("SECRET-VALUE");
  });
});
