import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
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
    "postgres://test@localhost:5432/focale_test_admin?host=unapproved.example",
    "postgres://test@localhost:5432/focale_test_admin?host=%2Ftmp%2Fpgsock",
    "postgres://test@localhost:5432/focale_test_admin?port=6543",
    "postgres://test@localhost:5432/focale_test_admin?hostaddr=192.0.2.20",
    "postgres://test@localhost:5432/focale_test_admin?database=postgres",
  ])("rejects a driver routing override before connection: %s", (url) => {
    expect(() => assertDisposableDatabaseUrl(url, "unapproved.example")).toThrow(/override|authority/);
  });

  it("rejects routing overrides on a rewritten scratch URL and preserves TLS options", () => {
    const routedAdmin = "postgres://test@localhost:32772/focale_test_admin?host=unapproved.example";
    const routedScratch = new URL(routedAdmin);
    routedScratch.pathname = "/focale_test_abc123_schema_deadbeef00";
    const driver = new Client({ connectionString: routedScratch.toString() });
    const routing = (driver as unknown as {
      connectionParameters: { host: string; port: number; database: string; isDomainSocket: boolean };
    }).connectionParameters;
    expect(routing).toMatchObject({ host: "unapproved.example", port: 32772, isDomainSocket: false });
    expect(() => assertDisposableDatabaseUrl(routedScratch.toString())).toThrow(/override/);

    const tlsUrl = "postgres://test@db.internal:26257/focale_ci_admin?sslmode=verify-full&sslrootcert=%2Ftmp%2Fca.crt";
    const validated = assertDisposableDatabaseUrl(tlsUrl, "db.internal");
    expect(validated.searchParams.get("sslmode")).toBe("verify-full");
    expect(validated.searchParams.get("sslrootcert")).toBe("/tmp/ca.crt");
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
