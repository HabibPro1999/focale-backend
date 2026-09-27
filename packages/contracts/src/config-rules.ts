import type { ParsedEnv } from "./app-env-schema";
import { decodeFirebaseServiceAccount } from "./firebase-service-account";
import { canonicalOrigin, listEntries, parseOriginList, isJsonObject, DEFAULT_LOCAL_ORIGIN } from "./env-values";
import { TRUST_PROXY_REQUIRED_MESSAGE, trustProxyValueError } from "./trust-proxy";

export interface ConfigIssue {
  /** Environment key the issue belongs to. */
  key: string;
  /** Rule text; never contains the configured value. */
  message: string;
}

const PUBLIC_LINK_ORIGINS_MESSAGE =
  "PUBLIC_LINK_ALLOWED_ORIGINS must contain valid HTTP(S) origins and is required in production";

/**
 * Rules spanning several keys or depending on NODE_ENV. Runs on best-effort
 * values (keys that failed their own schema read as undefined) so one pass
 * reports every failing key.
 */
export function crossKeyIssues(env: Partial<ParsedEnv>): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const add = (key: string, message: string) => issues.push({ key, message });
  const production = env.NODE_ENV === "production";

  if (env.FIREBASE_AUTH_LOOKUP_FALLBACK && !env.FIREBASE_WEB_API_KEY) {
    add(
      "FIREBASE_WEB_API_KEY",
      "FIREBASE_WEB_API_KEY is required when FIREBASE_AUTH_LOOKUP_FALLBACK=true",
    );
  }
  if (env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      decodeFirebaseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT);
    } catch (error) {
      add("FIREBASE_SERVICE_ACCOUNT", (error as Error).message);
    }
  }
  if (env.STORAGE_PROVIDER === "firebase" && !env.FIREBASE_STORAGE_BUCKET) {
    add("FIREBASE_STORAGE_BUCKET", "FIREBASE_STORAGE_BUCKET required when STORAGE_PROVIDER=firebase");
  }
  if (env.STORAGE_PROVIDER === "r2") {
    for (const key of [
      "R2_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_BUCKET",
      "R2_PUBLIC_URL",
    ] as const) {
      if (!env[key]) add(key, "R2 credentials required when STORAGE_PROVIDER=r2");
    }
  }

  // CORS: every entry an explicit origin; `*` only outside production.
  const corsEntries = listEntries(env.CORS_ORIGIN);
  if (corsEntries.includes("*") && production) {
    add("CORS_ORIGIN", "CORS_ORIGIN must list explicit origins in production; `*` is not allowed");
  } else if (
    env.CORS_ORIGIN !== undefined &&
    (corsEntries.length === 0 ||
      corsEntries.some((entry) => entry !== "*" && !canonicalOrigin(entry)))
  ) {
    add(
      "CORS_ORIGIN",
      "CORS_ORIGIN must be a comma-separated list of HTTP(S) origins (scheme://host[:port], no path)",
    );
  }

  if (env.TRUST_PROXY !== undefined) {
    const error = trustProxyValueError(env.TRUST_PROXY);
    if (error) add("TRUST_PROXY", error);
  } else if (production) {
    add("TRUST_PROXY", TRUST_PROXY_REQUIRED_MESSAGE);
  }

  const linkOrigins = parseOriginList(env.PUBLIC_LINK_ALLOWED_ORIGINS);
  if (linkOrigins === null || (production && linkOrigins.length === 0)) {
    add("PUBLIC_LINK_ALLOWED_ORIGINS", PUBLIC_LINK_ORIGINS_MESSAGE);
  }

  if (env.NETWORKING_EMAIL_SENDERS && !isJsonObject(env.NETWORKING_EMAIL_SENDERS)) {
    add("NETWORKING_EMAIL_SENDERS", "NETWORKING_EMAIL_SENDERS must be a JSON object keyed by client id");
  }

  if (!production) return issues;

  const sender = env.EMAIL_FROM_EMAIL ?? env.SENDGRID_FROM_EMAIL;
  if (env.EMAIL_PROVIDER === "sendgrid") {
    if (!env.SENDGRID_API_KEY) {
      add("SENDGRID_API_KEY", "SENDGRID_API_KEY is required in production when EMAIL_PROVIDER=sendgrid");
    }
    if (!sender) {
      add(
        "EMAIL_FROM_EMAIL",
        "A sender email (EMAIL_FROM_EMAIL or SENDGRID_FROM_EMAIL) is required in production when EMAIL_PROVIDER=sendgrid",
      );
    }
  }
  if (env.EMAIL_PROVIDER === "resend") {
    if (!env.RESEND_API_KEY) {
      add("RESEND_API_KEY", "RESEND_API_KEY is required in production when EMAIL_PROVIDER=resend");
    }
    if (!sender) {
      add(
        "EMAIL_FROM_EMAIL",
        "A sender email (EMAIL_FROM_EMAIL or SENDGRID_FROM_EMAIL) is required in production when EMAIL_PROVIDER=resend",
      );
    }
  }
  if (env.ADMIN_APP_URL === DEFAULT_LOCAL_ORIGIN) {
    add(
      "ADMIN_APP_URL",
      "ADMIN_APP_URL must be set to the deployed admin origin in production (default localhost:8080 not allowed)",
    );
  }
  if (!env.PUBLIC_FORMS_URL) {
    add("PUBLIC_FORMS_URL", "PUBLIC_FORMS_URL is required in production");
  }
  if (!env.NETWORKING_DISABLED && !env.NETWORKING_TOKEN_SECRET) {
    add(
      "NETWORKING_TOKEN_SECRET",
      "NETWORKING_TOKEN_SECRET is required in production unless NETWORKING_DISABLED=true",
    );
  }
  return issues;
}
