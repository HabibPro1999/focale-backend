import { afterEach, describe, expect, it, vi } from "vitest";
import { assertDisposableDatabaseUrl, dbTestsEnabled } from "./safety";

afterEach(() => vi.unstubAllEnvs());

describe("assertDisposableDatabaseUrl", () => {
  it.each([
    "postgres://user:secret@localhost:5432/focale_test_admin",
    "postgresql://user:secret@127.0.0.7:5432/focale_ci_admin",
    "postgres://user:secret@[::1]:26257/test_db",
  ])("accepts a loopback URL with an exact test token: %s", (url) => {
    expect(assertDisposableDatabaseUrl(url)).toBeInstanceOf(URL);
  });

  it("allows a remote hostname only when it exactly matches the allowlist", () => {
    const url = "postgres://user:secret@db.internal:5432/focale_ci_admin";
    expect(() => assertDisposableDatabaseUrl(url, "db.internal,other.internal")).not.toThrow();
    expect(() => assertDisposableDatabaseUrl(url, "internal")).toThrow(/loopback or listed/);
  });

  it.each([
    "postgres://user:secret@localhost:5432/pricing",
    "postgres://user:secret@localhost:5432/focale_testing_db",
    "postgres://user:secret@localhost:5432/focale_test_prod",
    "postgres://user:secret@staging-db.internal:5432/focale_test_admin",
    "mysql://user:secret@localhost:3306/focale_test_admin",
  ])("rejects unsafe database URLs: %s", (url) => {
    expect(() => assertDisposableDatabaseUrl(url, "staging-db.internal")).toThrow();
  });

  it("never includes URL credentials in validation errors", () => {
    let errorMessage = "";
    try {
      assertDisposableDatabaseUrl("postgres://alice:topsecret@db:5432/pricing");
    } catch (error) {
      errorMessage = (error as Error).message;
    }
    expect(errorMessage).not.toContain("alice");
    expect(errorMessage).not.toContain("topsecret");
  });

  it("fails closed when opt-in is set without an admin URL", () => {
    vi.stubEnv("ALLOW_DB_TESTS", "1");
    vi.stubEnv("TEST_DB_ADMIN_URL", "");
    expect(() => dbTestsEnabled()).toThrow(/requires TEST_DB_ADMIN_URL/);
  });
});
