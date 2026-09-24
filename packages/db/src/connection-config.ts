import type { ClientConfig, PoolConfig } from "pg";
import type { DbRuntimeSettings } from "@app/contracts";

/**
 * Pure builders for the application pool's connection settings.
 *
 * node-postgres merges `parse(connectionString)` OVER the explicit config, so a
 * query parameter such as `?options=-c TimeZone=…` would silently replace the
 * settings below. The pool therefore removes the keys it owns from the URL's
 * query string (authority and path stay byte-for-byte) and sends the session
 * settings in its own `options` startup string, with `TimeZone=UTC` last.
 * PostgreSQL and CockroachDB both apply `-c` settings in order.
 */

/** URL query keys pg would otherwise merge over the pool's own settings. */
const MANAGED_URL_PARAMETERS = [
  "options",
  "application_name",
  "statement_timeout",
  "idle_in_transaction_session_timeout",
] as const;

/** Session settings the pool pins; dropped from any carried URL `options`. */
const MANAGED_SESSION_SETTINGS = new Set([
  "timezone",
  "statement_timeout",
  "idle_in_transaction_session_timeout",
  "application_name",
]);

export const DEFAULT_DB_APPLICATION_NAME = "focale";
const APPLICATION_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,62}$/;

export function assertApplicationName(name: string): string {
  if (!APPLICATION_NAME.test(name)) {
    throw new Error(
      "Database application_name must be 1-63 characters: letters, digits, '.', '_', ':' or '-'",
    );
  }
  return name;
}

export interface StrippedConnectionString {
  connectionString: string;
  /** The URL's `options` value (last one wins, as in pg), if any. */
  urlOptions?: string;
}

/** Remove pool-managed keys from the query string only. */
export function stripManagedUrlParameters(raw: string): StrippedConnectionString {
  const fragmentAt = raw.indexOf("#");
  const beforeFragment = fragmentAt >= 0 ? raw.slice(0, fragmentAt) : raw;
  const fragment = fragmentAt >= 0 ? raw.slice(fragmentAt) : "";
  const queryAt = beforeFragment.indexOf("?");
  if (queryAt < 0) return { connectionString: raw };

  const params = new URLSearchParams(beforeFragment.slice(queryAt + 1));
  if (!MANAGED_URL_PARAMETERS.some((key) => params.has(key))) return { connectionString: raw };
  const urlOptions = params.getAll("options").at(-1);
  for (const key of MANAGED_URL_PARAMETERS) params.delete(key);
  const query = params.toString();
  return {
    connectionString: `${beforeFragment.slice(0, queryAt)}${query ? `?${query}` : ""}${fragment}`,
    ...(urlOptions === undefined ? {} : { urlOptions }),
  };
}

/** Split a libpq `options` string on unescaped whitespace, keeping escapes. */
function tokenize(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === "\\") {
      current += char + (value[index + 1] ?? "");
      index += 1;
      inToken = true;
    } else if (/\s/.test(char)) {
      if (inToken) tokens.push(current);
      current = "";
      inToken = false;
    } else {
      current += char;
      inToken = true;
    }
  }
  if (inToken) tokens.push(current);
  return tokens;
}

function settingName(setting: string): string {
  const unescaped = setting.replace(/\\(.)/gs, "$1");
  return unescaped.split("=")[0]!.trim().toLowerCase().replace(/-/g, "_");
}

/**
 * Keep every carried option (for example `--cluster=…` routing or
 * `-c search_path=…`) except settings the pool pins, in their original order.
 */
export function carriedSessionOptions(urlOptions: string | undefined): string[] {
  if (!urlOptions) return [];
  const tokens = tokenize(urlOptions);
  const kept: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    let group = [token];
    let setting: string | undefined;
    if (token === "-c" && index + 1 < tokens.length) {
      group = [token, tokens[index + 1]!];
      setting = tokens[index + 1];
      index += 1;
    } else if (token.startsWith("--")) {
      setting = token.slice(2);
    } else if (token.startsWith("-c")) {
      setting = token.slice(2);
    }
    if (setting !== undefined && MANAGED_SESSION_SETTINGS.has(settingName(setting))) continue;
    kept.push(...group);
  }
  return kept;
}

export function buildSessionOptions(
  urlOptions: string | undefined,
  settings: Pick<DbRuntimeSettings, "statementTimeoutMs" | "idleInTransactionTimeoutMs">,
): string {
  return [
    ...carriedSessionOptions(urlOptions),
    `-c statement_timeout=${settings.statementTimeoutMs}`,
    `-c idle_in_transaction_session_timeout=${settings.idleInTransactionTimeoutMs}`,
    // Last, so nothing carried from the URL can override it.
    "-c TimeZone=UTC",
  ].join(" ");
}

/** Per-session connection settings (everything except pool sizing). */
export function buildSessionConfig(
  databaseUrl: string,
  settings: DbRuntimeSettings,
  applicationName: string,
): ClientConfig {
  const { connectionString, urlOptions } = stripManagedUrlParameters(databaseUrl);
  return {
    connectionString,
    application_name: assertApplicationName(applicationName),
    options: buildSessionOptions(urlOptions, settings),
    // TCP keepalive so dead peers are noticed during long statements; the
    // first probe after 10 s idle instead of the OS default (2 h on Linux).
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  };
}

export function buildPoolConfig(
  databaseUrl: string,
  settings: DbRuntimeSettings,
  applicationName: string,
): PoolConfig {
  return {
    ...buildSessionConfig(databaseUrl, settings, applicationName),
    // Sizing/timeouts mirror the legacy src/database/client.ts config. Without
    // them node-postgres defaults to max=10 and connectionTimeoutMillis=0 (wait
    // forever when the pool is exhausted or the DB is down).
    max: settings.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };
}
