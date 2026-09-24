import { describe, expect, it } from "vitest";
import { Client, type ClientConfig } from "pg";
import {
  buildPoolConfig,
  buildSessionConfig,
  buildSessionOptions,
  carriedSessionOptions,
  stripManagedUrlParameters,
} from "./connection-config";

const settings = {
  poolMax: 7,
  statementTimeoutMs: 60_000,
  idleInTransactionTimeoutMs: 45_000,
  exportStatementTimeoutMs: 300_000,
};

const HOSTILE_URL =
  "postgresql://app:s3cr%40t@db.example.test:26257/focale?sslmode=verify-full" +
  "&options=--cluster%3Dtenant-42%20-c%20TimeZone%3DAmerica%2FNew_York%20-c%20search_path%3Dpublic%20-c%20statement_timeout%3D0" +
  "&application_name=from-url&statement_timeout=0&idle_in_transaction_session_timeout=0";

describe("stripManagedUrlParameters", () => {
  it("returns URLs without managed keys unchanged", () => {
    const url = "postgresql://u:p@localhost:5432/focale_dev?sslmode=require&sslrootcert=/etc/ca.pem";
    expect(stripManagedUrlParameters(url)).toEqual({ connectionString: url });
    expect(stripManagedUrlParameters("postgresql://u@localhost/db")).toEqual({
      connectionString: "postgresql://u@localhost/db",
    });
  });

  it("removes pool-owned keys from the query only and reports the URL options", () => {
    const { connectionString, urlOptions } = stripManagedUrlParameters(HOSTILE_URL);
    expect(connectionString).toBe("postgresql://app:s3cr%40t@db.example.test:26257/focale?sslmode=verify-full");
    expect(urlOptions).toBe(
      "--cluster=tenant-42 -c TimeZone=America/New_York -c search_path=public -c statement_timeout=0",
    );
  });

  it("keeps the last options value, as pg does, and drops the empty query", () => {
    expect(stripManagedUrlParameters("postgresql://h/db?options=-c%20a%3D1&options=-c%20b%3D2")).toEqual({
      connectionString: "postgresql://h/db",
      urlOptions: "-c b=2",
    });
  });
});

describe("carriedSessionOptions", () => {
  it("drops pinned settings in every libpq spelling and keeps the rest in order", () => {
    expect(
      carriedSessionOptions(
        "--cluster=tenant-42 -c TimeZone=Europe/Paris -cstatement_timeout=5 --idle-in-transaction-session-timeout=1 " +
          "-c application_name=x -c search_path=a\\ b --timezone=UTC -c TIMEZONE=Asia/Tokyo -c lock_timeout=100",
      ),
    ).toEqual(["--cluster=tenant-42", "-c", "search_path=a\\ b", "-c", "lock_timeout=100"]);
    expect(carriedSessionOptions(undefined)).toEqual([]);
    expect(carriedSessionOptions("   ")).toEqual([]);
  });
});

describe("session configuration", () => {
  it("puts the carried options first and TimeZone=UTC last", () => {
    expect(buildSessionOptions("--cluster=tenant-42 -c TimeZone=America/New_York", settings)).toBe(
      "--cluster=tenant-42 -c statement_timeout=60000 -c idle_in_transaction_session_timeout=45000 -c TimeZone=UTC",
    );
    expect(buildSessionOptions(undefined, { statementTimeoutMs: 0, idleInTransactionTimeoutMs: 0 })).toBe(
      "-c statement_timeout=0 -c idle_in_transaction_session_timeout=0 -c TimeZone=UTC",
    );
  });

  it("builds the pool config with keepalive, sizing and a validated application_name", () => {
    expect(buildPoolConfig("postgresql://u@localhost/db", settings, "focale-worker")).toEqual({
      connectionString: "postgresql://u@localhost/db",
      application_name: "focale-worker",
      options: "-c statement_timeout=60000 -c idle_in_transaction_session_timeout=45000 -c TimeZone=UTC",
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      max: 7,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    expect(() => buildSessionConfig("postgresql://u@localhost/db", settings, "bad name")).toThrow(
      /application_name/,
    );
    expect(() => buildSessionConfig("postgresql://u@localhost/db", settings, "x".repeat(64))).toThrow(
      /application_name/,
    );
  });
});

interface DriverParameters {
  options?: string;
  application_name?: string;
  statement_timeout: unknown;
  idle_in_transaction_session_timeout: unknown;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: unknown;
}

/** The driver's own ConnectionParameters instance (no connection is opened). */
function driverParameters(config: ClientConfig): DriverParameters {
  return (new Client(config) as unknown as { connectionParameters: DriverParameters }).connectionParameters;
}

// Offline proof against the installed driver: what node-postgres would put in
// the startup message for a hostile DATABASE_URL.
describe("node-postgres connection parameters (offline)", () => {
  it("lets URL options override an explicit TimeZone (the bug being fixed)", () => {
    const naive = driverParameters({ connectionString: HOSTILE_URL, options: "-c TimeZone=UTC" });
    expect(naive.options).toContain("TimeZone=America/New_York");
    expect(naive.options).not.toContain("TimeZone=UTC");
    expect(naive.application_name).toBe("from-url");
  });

  it("cannot be overridden once the pool config strips the URL", () => {
    const params = driverParameters(buildPoolConfig(HOSTILE_URL, settings, "focale-api"));
    expect(params.options).toBe(
      "--cluster=tenant-42 -c search_path=public -c statement_timeout=60000 " +
        "-c idle_in_transaction_session_timeout=45000 -c TimeZone=UTC",
    );
    expect(params.application_name).toBe("focale-api");
    expect(params.statement_timeout).toBe(false);
    expect(params.idle_in_transaction_session_timeout).toBe(false);
    expect(params.host).toBe("db.example.test");
    expect(params.port).toBe(26257);
    expect(params.database).toBe("focale");
    expect(params.user).toBe("app");
    expect(params.password).toBe("s3cr@t");
    expect(params.ssl).toBeTruthy();
  });

  it("sends exactly that startup message", () => {
    const client = new Client(buildSessionConfig(HOSTILE_URL, settings, "focale-api"));
    const startup = (client as unknown as { getStartupConf(): Record<string, string> }).getStartupConf();
    expect(startup).toEqual({
      user: "app",
      database: "focale",
      application_name: "focale-api",
      options:
        "--cluster=tenant-42 -c search_path=public -c statement_timeout=60000 " +
        "-c idle_in_transaction_session_timeout=45000 -c TimeZone=UTC",
    });
  });
});
