import { isIP } from "node:net";
import { Client } from "pg";

const PRODUCTION_TOKENS = new Set(["prod", "production", "main", "staging", "live"]);
const ROUTING_QUERY_PARAMETERS = new Set([
  "host",
  "hostaddr",
  "port",
  "socket",
  "service",
  "servicefile",
  "database",
  "dbname",
]);

function tokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const ipVersion = isIP(host);
  if (ipVersion === 4) return Number(host.split(".")[0]) === 127;
  return ipVersion === 6 && (host === "::1" || host === "0:0:0:0:0:0:0:1");
}

/**
 * Validate a database URL before any test helper connects or issues DDL.
 * Remote hosts require an explicit exact-host allowlist; the database name
 * must contain a complete `test` or `ci` token and no production-like token.
 */
export function assertDisposableDatabaseUrl(
  databaseUrl: string,
  allowedHosts = process.env.TEST_DB_ALLOWED_HOSTS ?? "",
): URL {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("[test-db] Database URL is invalid.");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("[test-db] Database URL must use postgres:// or postgresql://.");
  }

  if ([...parsed.searchParams.keys()].some((key) => ROUTING_QUERY_PARAMETERS.has(key.toLowerCase()))) {
    throw new Error("[test-db] Database URL must not override its connection host or port in query parameters.");
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName || !/^[A-Za-z0-9_.-]+$/.test(databaseName)) {
    throw new Error("[test-db] Database URL must contain a simple database name.");
  }
  const databaseTokens = tokens(databaseName);
  if (!databaseTokens.includes("test") && !databaseTokens.includes("ci")) {
    throw new Error("[test-db] Database name must contain an exact 'test' or 'ci' token.");
  }
  if (databaseTokens.some((token) => PRODUCTION_TOKENS.has(token))) {
    throw new Error("[test-db] Refusing a production-like database name.");
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const routingProbe = new URL(parsed.toString());
  routingProbe.search = "";
  const driver = new Client({ connectionString: routingProbe.toString() });
  const routing = (driver as unknown as {
    connectionParameters: { host: string; port: number; database: string; isDomainSocket: boolean };
  }).connectionParameters;
  const driverHost = routing.host.toLowerCase().replace(/^\[|\]$/g, "");
  const urlPort = parsed.port ? Number(parsed.port) : 5432;
  if (routing.isDomainSocket || driverHost !== host || routing.port !== urlPort || routing.database !== databaseName) {
    throw new Error("[test-db] Database URL must connect to the database, host, and port in its authority.");
  }
  if (tokens(host).some((token) => PRODUCTION_TOKENS.has(token))) {
    throw new Error("[test-db] Refusing a production-like database host.");
  }
  const explicitHosts = new Set(
    allowedHosts
      .split(",")
      .map((item) => item.trim().toLowerCase().replace(/^\[|\]$/g, ""))
      .filter(Boolean),
  );
  if (!isLoopback(host) && !explicitHosts.has(host)) {
    throw new Error("[test-db] Database host must be loopback or listed in TEST_DB_ALLOWED_HOSTS.");
  }
  return parsed;
}

/** Missing opt-in skips DB suites; opting in requires a safe admin URL. */
export function dbTestsEnabled(): boolean {
  if (process.env.ALLOW_DB_TESTS !== "1") return false;
  const adminUrl = process.env.TEST_DB_ADMIN_URL;
  if (!adminUrl) {
    throw new Error("[test-db] ALLOW_DB_TESTS=1 requires TEST_DB_ADMIN_URL.");
  }
  assertDisposableDatabaseUrl(adminUrl);
  return true;
}

/** Validate the opt-in environment and return the checked admin URL. */
export function loadDbTestAdminUrl(): string {
  process.env.NODE_ENV ??= "test";
  if (process.env.ALLOW_DB_TESTS !== "1") {
    throw new Error("[test-db] DB test tiers are opt-in. Set ALLOW_DB_TESTS=1 to continue.");
  }
  const adminUrl = process.env.TEST_DB_ADMIN_URL;
  if (!adminUrl) {
    throw new Error("[test-db] ALLOW_DB_TESTS=1 requires TEST_DB_ADMIN_URL.");
  }
  assertDisposableDatabaseUrl(adminUrl);
  return adminUrl;
}
