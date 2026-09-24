import { z } from "zod";
import { dbEnvShape, dbRuntimeSettingsFrom } from "./db-settings";
import { envFlag, envInt, envKey, envKeyMeta } from "./env-meta";
import { decodeFirebaseServiceAccount } from "./firebase-service-account";
import {
  TRUST_PROXY_REQUIRED_MESSAGE,
  resolveTrustProxy,
  trustProxyValueError,
} from "./trust-proxy";

// The single environment schema for both apps. Zod-only (plus node builtins)
// so contracts stays a leaf package. Each app parses it once at boot
// (core/config.ts getConfig) and hands typed slices to @app/db (configureDb)
// and @app/integrations (configureIntegrations). Every key carries `.meta()`
// documentation; `.env.example` is generated from it (pnpm env:example).
//
// Validation messages never echo configured values: the boot error and the
// operator check (cli/check-config.ts) print key names and rule text only.

export const DEFAULT_LOCAL_ORIGIN = "http://localhost:8080";

const envShape = {
  // --- Core ---------------------------------------------------------------
  NODE_ENV: envKey(z.enum(["development", "production", "test"]).default("development"), {
    section: "core",
    description:
      "development | production | test. The image sets production; production turns on the rules marked below.",
    example: "development",
    active: true,
  }),
  PORT: envInt(0, 65_535, 3000, {
    section: "core",
    description: "API HTTP port.",
    example: "3000",
    active: true,
  }, "PORT"),

  // --- Database -----------------------------------------------------------
  DATABASE_URL: envKey(z.string().url(), {
    section: "database",
    description:
      "PostgreSQL/CockroachDB connection URL. Required.\nThe pool pins TimeZone=UTC; `options`, `application_name` and timeout query\nparameters in the URL are replaced by the DB_* settings below.",
    example: "postgresql://dev_user:dev_password@localhost:5432/focale_dev",
    active: true,
  }),
  ...dbEnvShape,
  MIGRATIONS_CHECK: envKey(z.enum(["enforce", "warn", "off"]).default("warn"), {
    section: "database",
    description:
      "Boot-time schema check against the migration ledger: enforce (refuse to start), warn (log), off.\nDefault warn until the production ledger has been adopted (packages/db/src/migrator/README.md).",
    example: "warn",
  }),

  // --- HTTP ---------------------------------------------------------------
  CORS_ORIGIN: envKey(z.string().default(DEFAULT_LOCAL_ORIGIN), {
    section: "http",
    description:
      "Comma-separated browser origins allowed to call the API (scheme://host[:port], no path).\n`*` is accepted outside production only; production requires explicit origins.",
    example: DEFAULT_LOCAL_ORIGIN,
    active: true,
  }),
  TRUST_PROXY: envKey(z.string().optional(), {
    section: "http",
    description:
      "Comma-separated IP/CIDR addresses of trusted reverse-proxy peers. Forwarded client IP\nheaders are ignored unless the connecting peer matches this list. Required in production;\nset TRUST_PROXY=false only when clients connect directly to the API with no proxy.\nReplace any old numeric hop-count setting with the actual proxy peer addresses from your\ndeployment network configuration. Do not use true, *, or a /0 range.\nExample only; never copy these documentation/test addresses into production.",
    example: "10.0.0.0/24,2001:db8:1234::/48",
  }),

  // --- Public URLs --------------------------------------------------------
  ADMIN_APP_URL: envKey(z.string().url().default(DEFAULT_LOCAL_ORIGIN), {
    section: "urls",
    description:
      "Admin app base URL. Committee invite emails link to ${ADMIN_APP_URL}/committee/set-password.\nThe Firebase Console action URL for password resets points at ${ADMIN_APP_URL}/auth/action.\nProduction must set the deployed admin origin (the localhost default is rejected).",
    example: DEFAULT_LOCAL_ORIGIN,
    active: true,
  }),
  PUBLIC_FORMS_URL: envKey(z.string().url().optional(), {
    section: "urls",
    description:
      "Public forms base URL for registration and abstract links in emails when a submission\ncarries no link base. Required in production; defaults to http://localhost:8080 elsewhere.",
    example: "https://forms.example.invalid",
  }),
  PUBLIC_LINK_ALLOWED_ORIGINS: envKey(z.string().optional(), {
    section: "urls",
    description:
      "Comma-separated exact HTTP(S) origins allowed as the link base stored with public\nregistrations and abstracts. Required in production.",
    example: "https://forms.example.invalid",
  }),

  // --- Firebase -----------------------------------------------------------
  FIREBASE_PROJECT_ID: envKey(z.string(), {
    section: "firebase",
    description: "Firebase project (admin authentication). Required.",
    example: "replace-with-firebase-project-id",
    active: true,
  }),
  FIREBASE_STORAGE_BUCKET: envKey(z.string().optional(), {
    section: "firebase",
    description: "Storage bucket. Required when STORAGE_PROVIDER=firebase.",
    example: "replace-with-firebase-storage-bucket",
    active: true,
  }),
  FIREBASE_SERVICE_ACCOUNT: envKey(z.string().optional(), {
    section: "firebase",
    description:
      "Service account JSON for deployed runtimes, raw or base64-encoded. When unset, the\nAdmin SDK uses application default credentials (GOOGLE_APPLICATION_CREDENTIALS).",
    example: '{"type":"service_account","project_id":"replace-with-project-id"}',
  }),
  GOOGLE_APPLICATION_CREDENTIALS: envKey(z.string().optional(), {
    section: "firebase",
    description: "Path to a service account file (application default credentials).",
    example: "/path/to/service-account.json",
  }),
  FIREBASE_AUTH_LOOKUP_FALLBACK: envFlag(false, {
    section: "firebase",
    description:
      "ID-token verification fallback (off by default). When the Admin SDK cannot fetch Google's\nx509 public keys (e.g. an egress block), admin sign-in fails unless this is enabled: the API\nthen verifies tokens via identitytoolkit accounts:lookup and checks aud/iss/exp/sub/auth_time\nagainst FIREBASE_PROJECT_ID. Requires FIREBASE_WEB_API_KEY (boot fails without it); there is\nno built-in default. Successful lookups are cached for up to 5 minutes, so on this path a\nrevoked token can stay accepted for up to 5 minutes.",
    example: "false",
  }),
  FIREBASE_WEB_API_KEY: envKey(z.string().optional(), {
    section: "firebase",
    description: "Web API key of FIREBASE_PROJECT_ID; used only by the lookup fallback.",
    example: "replace-with-project-web-api-key",
  }),

  // --- Storage ------------------------------------------------------------
  STORAGE_PROVIDER: envKey(z.enum(["firebase", "r2"]).default("firebase"), {
    section: "storage",
    description: "firebase | r2.",
    example: "firebase",
    active: true,
  }),
  R2_ACCOUNT_ID: envKey(z.string().optional(), {
    section: "storage",
    description: "Cloudflare R2 (every R2_* key is required when STORAGE_PROVIDER=r2).",
    example: "replace-with-r2-account-id",
  }),
  R2_ACCESS_KEY_ID: envKey(z.string().optional(), {
    section: "storage",
    description: "",
    example: "replace-with-r2-access-key-id",
  }),
  R2_SECRET_ACCESS_KEY: envKey(z.string().optional(), {
    section: "storage",
    description: "",
    example: "replace-with-r2-secret-access-key",
  }),
  R2_BUCKET: envKey(z.string().optional(), {
    section: "storage",
    description: "",
    example: "replace-with-r2-bucket-name",
  }),
  R2_PUBLIC_URL: envKey(z.string().url().optional(), {
    section: "storage",
    description: "",
    example: "https://assets.example.invalid",
  }),

  // --- Email --------------------------------------------------------------
  EMAIL_PROVIDER: envKey(z.enum(["sendgrid", "resend"]).default("sendgrid"), {
    section: "email",
    description:
      "sendgrid | resend. Production requires the selected provider's API key and a sender.",
    example: "sendgrid",
  }),
  EMAIL_FROM_EMAIL: envKey(z.string().email().optional(), {
    section: "email",
    description:
      "Shared sender identity for whichever provider is active (falls back to SENDGRID_FROM_*).",
    example: "noreply@example.invalid",
  }),
  EMAIL_FROM_NAME: envKey(z.string().optional(), {
    section: "email",
    description: "",
    example: "Focale Events",
  }),
  SENDGRID_API_KEY: envKey(z.string().optional(), {
    section: "email",
    description: "SendGrid (EMAIL_PROVIDER=sendgrid). The API key is required in production.",
    example: "replace-with-sendgrid-api-key",
  }),
  SENDGRID_WEBHOOK_PUBLIC_KEY: envKey(z.string().optional(), {
    section: "email",
    description: "",
    example: "replace-with-sendgrid-webhook-public-key",
  }),
  SENDGRID_FROM_EMAIL: envKey(z.string().email().optional(), {
    section: "email",
    description: "",
    example: "noreply@example.invalid",
  }),
  SENDGRID_FROM_NAME: envKey(z.string().optional(), {
    section: "email",
    description: "",
    example: "Focale Events",
  }),
  RESEND_API_KEY: envKey(z.string().optional(), {
    section: "email",
    description: "Resend (EMAIL_PROVIDER=resend). The API key is required in production.",
    example: "replace-with-resend-api-key",
  }),
  RESEND_WEBHOOK_SECRET: envKey(z.string().optional(), {
    section: "email",
    description: "",
    example: "whsec_replace-with-resend-webhook-signing-secret",
  }),
  SENDGRID_DOMAIN_READ_API_KEY: envKey(z.string().optional(), {
    section: "email",
    description:
      "Optional provider credentials with domain-read access, used to verify networking senders\n(default: the provider's API key).",
    example: "replace-with-sendgrid-domain-read-key",
  }),
  RESEND_DOMAIN_READ_API_KEY: envKey(z.string().optional(), {
    section: "email",
    description: "",
    example: "replace-with-resend-domain-read-key",
  }),

  // --- Realtime -----------------------------------------------------------
  REALTIME_DISABLED: envFlag(false, {
    section: "realtime",
    description:
      "Disables the SSE outbox pump in the API. realtime.emit rows then accumulate; only disable\nwhere nothing produces them.",
    example: "false",
    active: true,
  }),
  SSE_HEARTBEAT_MS: envKey(z.coerce.number().int().positive().default(25_000), {
    section: "realtime",
    description: "SSE heartbeat interval in ms.",
    example: "25000",
    active: true,
  }),
  SSE_CLIENT_RETRY_MS: envKey(z.coerce.number().int().positive().default(15_000), {
    section: "realtime",
    description: "SSE client reconnect delay in ms.",
    example: "15000",
    active: true,
  }),

  // --- Abstracts ----------------------------------------------------------
  ABSTRACTS_SUBMIT_RATE_LIMIT_MAX: envKey(z.coerce.number().int().positive().default(60), {
    section: "abstracts",
    description:
      "Public abstracts rate limits per IP and window (tunable for congress NAT/shared Wi-Fi).",
    example: "60",
    active: true,
  }),
  ABSTRACTS_EDIT_RATE_LIMIT_MAX: envKey(z.coerce.number().int().positive().default(30), {
    section: "abstracts",
    description: "",
    example: "30",
    active: true,
  }),
  ABSTRACTS_READ_RATE_LIMIT_MAX: envKey(z.coerce.number().int().positive().default(120), {
    section: "abstracts",
    description: "",
    example: "120",
    active: true,
  }),
  ABSTRACTS_RATE_LIMIT_WINDOW: envKey(
    z
      .string()
      .default("1 minute")
      .refine((value) => parseRateLimitWindowMs(value) !== null, {
        error:
          'ABSTRACTS_RATE_LIMIT_WINDOW must be milliseconds or "<n> <ms|s|m|min|minute(s)|h|hour(s)>"',
      }),
    {
      section: "abstracts",
      description: 'Window: milliseconds or "<n> <unit>" (ms, s, m/min/minute(s), h/hour(s)).',
      example: "1 minute",
      active: true,
    },
  ),

  COMMITTEE_INVITE_TOKEN_TTL_DAYS: envKey(z.coerce.number().int().positive().default(7), {
    section: "abstracts",
    description: "Committee invite links: days a single-use invite token stays valid.",
    example: "7",
  }),

  // --- Certificates -------------------------------------------------------
  CERTIFICATE_FONT_PATH: envKey(z.string().optional(), {
    section: "certificates",
    description: "Certificate PDF font overrides (bundled fonts when unset).",
    example: "/path/to/regular.ttf",
  }),
  CERTIFICATE_BOLD_FONT_PATH: envKey(z.string().optional(), {
    section: "certificates",
    description: "",
    example: "/path/to/bold.ttf",
  }),

  // --- Networking ---------------------------------------------------------
  NETWORKING_DISABLED: envFlag(false, {
    section: "networking",
    description:
      "Set true only where no event uses networking: NETWORKING_TOKEN_SECRET is then not required\nand participant authentication returns 503.",
    example: "false",
  }),
  PUBLIC_NETWORKING_URL: envKey(z.string().url().optional(), {
    section: "networking",
    description: "Networking PWA base URL (event links and push notification targets).",
    example: "http://localhost:8082",
    active: true,
  }),
  NETWORKING_TOKEN_SECRET: envKey(z.string().min(32).optional(), {
    section: "networking",
    description:
      "Signs participant tokens and seals OTP codes (at least 32 characters).\nRequired in production unless NETWORKING_DISABLED=true. Generate with: openssl rand -hex 32",
    example: "replace-with-openssl-rand-hex-32-output",
  }),
  NETWORKING_EMBEDDING_API_KEY: envKey(z.string().optional(), {
    section: "networking",
    description:
      "OpenAI-compatible embeddings endpoint (fixed 1536-dimensional storage). Without a key\n(or OPENAI_API_KEY) recommendations skip embeddings.",
    example: "replace-with-embeddings-api-key",
  }),
  OPENAI_API_KEY: envKey(z.string().optional(), {
    section: "networking",
    description: "Fallback for NETWORKING_EMBEDDING_API_KEY.",
    example: "replace-with-openai-api-key",
  }),
  NETWORKING_EMBEDDING_MODEL: envKey(z.string().default("text-embedding-3-small"), {
    section: "networking",
    description: "",
    example: "text-embedding-3-small",
    active: true,
  }),
  NETWORKING_EMBEDDING_BASE_URL: envKey(z.string().url().default("https://api.openai.com/v1"), {
    section: "networking",
    description: "",
    example: "https://api.openai.com/v1",
    active: true,
  }),
  NETWORKING_EMBEDDING_BATCH_SIZE: envInt(1, 32, 16, {
    section: "networking",
    description: "Bounded worker throughput; tune to the provider's rate limits and DB capacity.",
    example: "16",
    active: true,
  }, "NETWORKING_EMBEDDING_BATCH_SIZE"),
  NETWORKING_EMBEDDING_BATCHES_PER_TICK: envInt(1, 32, 8, {
    section: "networking",
    description: "",
    example: "8",
    active: true,
  }, "NETWORKING_EMBEDDING_BATCHES_PER_TICK"),
  NETWORKING_EMBEDDING_CONCURRENCY: envInt(1, 4, 2, {
    section: "networking",
    description: "",
    example: "2",
    active: true,
  }, "NETWORKING_EMBEDDING_CONCURRENCY"),
  NETWORKING_VAPID_PUBLIC_KEY: envKey(z.string().optional(), {
    section: "networking",
    description:
      "Web push. Generate once with web-push generateVAPIDKeys; keep the private key server-side.\nPush is off until all three are set.",
    example: "replace-with-vapid-public-key",
  }),
  NETWORKING_VAPID_PRIVATE_KEY: envKey(z.string().optional(), {
    section: "networking",
    description: "",
    example: "replace-with-vapid-private-key",
  }),
  NETWORKING_VAPID_SUBJECT: envKey(z.string().optional(), {
    section: "networking",
    description: "",
    example: "mailto:contact@example.invalid",
  }),
  NETWORKING_EMAIL_SENDERS: envKey(z.string().optional(), {
    section: "networking",
    description: "Optional server-owned networking sender map (JSON object), keyed by client UUID.",
    example:
      '{"client-uuid":{"provider":"resend","email":"networking@events.example.invalid","domainId":"domain-id","name":"Organizer"}}',
  }),

  // --- Processes ----------------------------------------------------------
  RUN_WORKERS: envKey(z.string().optional(), {
    section: "processes",
    description:
      'Worker kill switch: background jobs run unless this is the literal "false".',
    example: "true",
  }),
  LOG_LEVEL: envKey(
    z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),
    {
      section: "processes",
      description: "fatal | error | warn | info | debug | trace | silent.",
      example: "info",
    },
  ),
};

/** Every documented environment key, in schema order (drives `.env.example`). */
export const APP_ENV_SHAPE: Readonly<Record<string, z.ZodType>> = envShape;

const envObject = z.object(envShape);
type ParsedEnv = z.infer<typeof envObject>;

// Keys @app/integrations reads. The same field schemas back the lenient
// env fallback used when configureIntegrations was never called (unit tests,
// one-off scripts); FIREBASE_PROJECT_ID is optional there.
const integrationsEnvObject = z.object({
  NODE_ENV: envShape.NODE_ENV,
  FIREBASE_PROJECT_ID: envKey(z.string().optional(), envKeyMeta(envShape.FIREBASE_PROJECT_ID)!),
  FIREBASE_STORAGE_BUCKET: envShape.FIREBASE_STORAGE_BUCKET,
  FIREBASE_SERVICE_ACCOUNT: envShape.FIREBASE_SERVICE_ACCOUNT,
  FIREBASE_AUTH_LOOKUP_FALLBACK: envShape.FIREBASE_AUTH_LOOKUP_FALLBACK,
  FIREBASE_WEB_API_KEY: envShape.FIREBASE_WEB_API_KEY,
  STORAGE_PROVIDER: envShape.STORAGE_PROVIDER,
  R2_ACCOUNT_ID: envShape.R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID: envShape.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: envShape.R2_SECRET_ACCESS_KEY,
  R2_BUCKET: envShape.R2_BUCKET,
  R2_PUBLIC_URL: envShape.R2_PUBLIC_URL,
  EMAIL_PROVIDER: envShape.EMAIL_PROVIDER,
  EMAIL_FROM_EMAIL: envShape.EMAIL_FROM_EMAIL,
  EMAIL_FROM_NAME: envShape.EMAIL_FROM_NAME,
  SENDGRID_API_KEY: envShape.SENDGRID_API_KEY,
  SENDGRID_WEBHOOK_PUBLIC_KEY: envShape.SENDGRID_WEBHOOK_PUBLIC_KEY,
  SENDGRID_FROM_EMAIL: envShape.SENDGRID_FROM_EMAIL,
  SENDGRID_FROM_NAME: envShape.SENDGRID_FROM_NAME,
  SENDGRID_DOMAIN_READ_API_KEY: envShape.SENDGRID_DOMAIN_READ_API_KEY,
  RESEND_API_KEY: envShape.RESEND_API_KEY,
  RESEND_WEBHOOK_SECRET: envShape.RESEND_WEBHOOK_SECRET,
  RESEND_DOMAIN_READ_API_KEY: envShape.RESEND_DOMAIN_READ_API_KEY,
  CERTIFICATE_FONT_PATH: envShape.CERTIFICATE_FONT_PATH,
  CERTIFICATE_BOLD_FONT_PATH: envShape.CERTIFICATE_BOLD_FONT_PATH,
  PUBLIC_FORMS_URL: envShape.PUBLIC_FORMS_URL,
  NETWORKING_DISABLED: envShape.NETWORKING_DISABLED,
  PUBLIC_NETWORKING_URL: envShape.PUBLIC_NETWORKING_URL,
  NETWORKING_TOKEN_SECRET: envShape.NETWORKING_TOKEN_SECRET,
  NETWORKING_EMBEDDING_API_KEY: envShape.NETWORKING_EMBEDDING_API_KEY,
  OPENAI_API_KEY: envShape.OPENAI_API_KEY,
  NETWORKING_EMBEDDING_MODEL: envShape.NETWORKING_EMBEDDING_MODEL,
  NETWORKING_EMBEDDING_BASE_URL: envShape.NETWORKING_EMBEDDING_BASE_URL,
  NETWORKING_EMBEDDING_BATCH_SIZE: envShape.NETWORKING_EMBEDDING_BATCH_SIZE,
  NETWORKING_EMBEDDING_BATCHES_PER_TICK: envShape.NETWORKING_EMBEDDING_BATCHES_PER_TICK,
  NETWORKING_EMBEDDING_CONCURRENCY: envShape.NETWORKING_EMBEDDING_CONCURRENCY,
  NETWORKING_VAPID_PUBLIC_KEY: envShape.NETWORKING_VAPID_PUBLIC_KEY,
  NETWORKING_VAPID_PRIVATE_KEY: envShape.NETWORKING_VAPID_PRIVATE_KEY,
  NETWORKING_VAPID_SUBJECT: envShape.NETWORKING_VAPID_SUBJECT,
  NETWORKING_EMAIL_SENDERS: envShape.NETWORKING_EMAIL_SENDERS,
});
type IntegrationsEnv = z.infer<typeof integrationsEnvObject>;

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

/**
 * Canonical origin of an HTTP(S) URL with no credentials, path, query, hash
 * or wildcard (URL parsing would accept a `*` host label).
 */
function canonicalOrigin(value: string): string | null {
  if (value.includes("*")) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function listEntries(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Canonical origins of a comma list, or null when any entry is invalid. */
function parseOriginList(raw: string | undefined): string[] | null {
  const origins: string[] = [];
  for (const entry of listEntries(raw)) {
    const origin = canonicalOrigin(entry);
    if (!origin) return null;
    origins.push(origin);
  }
  return [...new Set(origins)];
}

/** Parse a rate-limit window: bare milliseconds or "<n> <unit>". */
export function parseRateLimitWindowMs(raw: string): number | null {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match =
    /^(\d+)\s*(ms|s|sec|second|seconds|m|min|minute|minutes|h|hour|hours)$/i.exec(trimmed);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  if (unit === "ms") return n;
  if (unit.startsWith("h")) return n * 3_600_000;
  if (unit === "m" || unit.startsWith("min")) return n * 60_000;
  return n * 1_000;
}

function isJsonObject(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Cross-key and production rules
// ---------------------------------------------------------------------------

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
function crossKeyIssues(env: Partial<ParsedEnv>): ConfigIssue[] {
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

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export class ConfigError extends Error {
  constructor(public readonly issues: ConfigIssue[]) {
    const details = issues.map((issue) => `  - ${issue.key}: ${issue.message}`).join("\n");
    super(`Environment validation failed:\n${details}`);
    this.name = "ConfigError";
  }
}

function zodIssues(error: z.ZodError): ConfigIssue[] {
  return error.issues.map((issue) => ({
    key: issue.path.map(String).join(".") || "(root)",
    message: issue.message,
  }));
}

/**
 * Validate an environment: every key's own schema, then the cross-key and
 * production rules. Keys that fail their own schema are re-read as unset so
 * the rules still run and one pass lists every failing key.
 */
export function validateAppEnv(
  source: NodeJS.ProcessEnv,
): { ok: true; env: ParsedEnv } | { ok: false; issues: ConfigIssue[] } {
  const parsed = envObject.safeParse(source);
  if (parsed.success) {
    const issues = crossKeyIssues(parsed.data);
    return issues.length ? { ok: false, issues } : { ok: true, env: parsed.data };
  }

  const fieldIssues = zodIssues(parsed.error);
  const failed = new Set(fieldIssues.map((issue) => issue.key));
  const relaxed = z
    .object(
      Object.fromEntries(
        Object.entries(envShape).map(([key, schema]) => [
          key,
          failed.has(key) ? z.any().optional().transform(() => undefined) : schema,
        ]),
      ),
    )
    .safeParse(source);
  const ruleIssues = relaxed.success
    ? crossKeyIssues(relaxed.data as Partial<ParsedEnv>).filter((issue) => !failed.has(issue.key))
    : [];
  return { ok: false, issues: [...fieldIssues, ...ruleIssues] };
}

export interface NetworkingRuntimeConfig {
  disabled: boolean;
  publicUrl?: string;
  /** Unset when NETWORKING_DISABLED=true or not configured. */
  tokenSecret?: string;
  embedding: {
    apiKey?: string;
    model: string;
    baseUrl: string;
    batchSize: number;
    batchesPerTick: number;
    concurrency: number;
  };
  vapid: { publicKey?: string; privateKey?: string; subject?: string };
  /** Raw JSON sender map; per-client entries are validated where they are used. */
  emailSenders?: string;
}

/** The typed slice @app/integrations receives through configureIntegrations. */
export interface IntegrationsConfig {
  isProduction: boolean;
  firebase: {
    projectId?: string;
    storageBucket?: string;
    /** Raw or base64 JSON; decode with decodeFirebaseServiceAccount. */
    serviceAccount?: string;
    authLookupFallback: boolean;
    webApiKey?: string;
  };
  storage: { provider: "firebase" | "r2" };
  r2: {
    accountId?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    bucket?: string;
    publicUrl?: string;
  };
  email: {
    provider: "sendgrid" | "resend";
    fromEmail: string;
    fromName: string;
    sendgrid: { apiKey?: string; webhookPublicKey?: string; domainReadApiKey?: string };
    resend: { apiKey?: string; webhookSecret?: string; domainReadApiKey?: string };
  };
  certificates: { fontPath?: string; boldFontPath?: string };
  /** Base for registration/abstract links when a submission stored none. */
  publicFormsUrl: string;
  networking: NetworkingRuntimeConfig;
}

function integrationsSliceFrom(env: IntegrationsEnv): IntegrationsConfig {
  return {
    isProduction: env.NODE_ENV === "production",
    firebase: {
      projectId: env.FIREBASE_PROJECT_ID,
      storageBucket: env.FIREBASE_STORAGE_BUCKET,
      serviceAccount: env.FIREBASE_SERVICE_ACCOUNT,
      authLookupFallback: env.FIREBASE_AUTH_LOOKUP_FALLBACK,
      webApiKey: env.FIREBASE_WEB_API_KEY,
    },
    storage: { provider: env.STORAGE_PROVIDER },
    r2: {
      accountId: env.R2_ACCOUNT_ID,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucket: env.R2_BUCKET,
      publicUrl: env.R2_PUBLIC_URL,
    },
    email: {
      provider: env.EMAIL_PROVIDER,
      // Shared sender identity, with back-compat fallback to the legacy SendGrid vars.
      fromEmail: env.EMAIL_FROM_EMAIL ?? env.SENDGRID_FROM_EMAIL ?? "noreply@example.com",
      fromName: env.EMAIL_FROM_NAME ?? env.SENDGRID_FROM_NAME ?? "Event Platform",
      sendgrid: {
        apiKey: env.SENDGRID_API_KEY,
        webhookPublicKey: env.SENDGRID_WEBHOOK_PUBLIC_KEY,
        domainReadApiKey: env.SENDGRID_DOMAIN_READ_API_KEY,
      },
      resend: {
        apiKey: env.RESEND_API_KEY,
        webhookSecret: env.RESEND_WEBHOOK_SECRET,
        domainReadApiKey: env.RESEND_DOMAIN_READ_API_KEY,
      },
    },
    certificates: {
      fontPath: env.CERTIFICATE_FONT_PATH,
      boldFontPath: env.CERTIFICATE_BOLD_FONT_PATH,
    },
    // Production requires PUBLIC_FORMS_URL; elsewhere links point at the local form app.
    publicFormsUrl: env.PUBLIC_FORMS_URL ?? DEFAULT_LOCAL_ORIGIN,
    networking: {
      disabled: env.NETWORKING_DISABLED,
      publicUrl: env.PUBLIC_NETWORKING_URL,
      tokenSecret: env.NETWORKING_DISABLED ? undefined : env.NETWORKING_TOKEN_SECRET,
      embedding: {
        apiKey: env.NETWORKING_EMBEDDING_API_KEY ?? env.OPENAI_API_KEY,
        model: env.NETWORKING_EMBEDDING_MODEL,
        baseUrl: env.NETWORKING_EMBEDDING_BASE_URL,
        batchSize: env.NETWORKING_EMBEDDING_BATCH_SIZE,
        batchesPerTick: env.NETWORKING_EMBEDDING_BATCHES_PER_TICK,
        concurrency: env.NETWORKING_EMBEDDING_CONCURRENCY,
      },
      vapid: {
        publicKey: env.NETWORKING_VAPID_PUBLIC_KEY,
        privateKey: env.NETWORKING_VAPID_PRIVATE_KEY,
        subject: env.NETWORKING_VAPID_SUBJECT,
      },
      emailSenders: env.NETWORKING_EMAIL_SENDERS,
    },
  };
}

/**
 * Integrations slice read straight from an environment, without the
 * cross-key/production rules. Only for code paths that never received a
 * configured slice (unit tests, one-off scripts); the apps always call
 * configureIntegrations with parseAppConfig(...).integrations.
 */
export function integrationsConfigFromEnv(source: NodeJS.ProcessEnv): IntegrationsConfig {
  const parsed = integrationsEnvObject.safeParse(source);
  if (!parsed.success) throw new ConfigError(zodIssues(parsed.error));
  return integrationsSliceFrom(parsed.data);
}

export function parseAppConfig(source: NodeJS.ProcessEnv) {
  const result = validateAppEnv(source);
  if (!result.ok) throw new ConfigError(result.issues);

  const env = result.env;
  const isDevelopment = env.NODE_ENV === "development";
  const isProduction = env.NODE_ENV === "production";
  const integrations = integrationsSliceFrom(env);
  const corsEntries = listEntries(env.CORS_ORIGIN);

  return {
    ...env,
    isDevelopment,
    isProduction,
    isTest: env.NODE_ENV === "test",
    // LOG_LEVEL is new; keep the legacy NODE_ENV-driven default when unset.
    logLevel: env.LOG_LEVEL ?? (isDevelopment ? "debug" : "info"),
    // Legacy: workers run unless RUN_WORKERS is the literal string "false".
    runWorkers: env.RUN_WORKERS !== "false",
    // Same values the db client derives at pool construction.
    database: dbRuntimeSettingsFrom(env, env.NODE_ENV),
    http: {
      /** Fastify `trustProxy`: explicit peer list, or false (socket address). */
      trustProxy: resolveTrustProxy(env.TRUST_PROXY),
      cors: {
        /** `*` entry, accepted outside production only. */
        allowAnyOrigin: corsEntries.includes("*"),
        origins: parseOriginList(corsEntries.filter((entry) => entry !== "*").join(",")) ?? [],
      },
    },
    security: {
      rateLimit: {
        max: isProduction ? 100 : 1000,
        timeWindow: "1 minute",
      },
      committeeInvite: { tokenTtlDays: env.COMMITTEE_INVITE_TOKEN_TTL_DAYS },
      publicAbstracts: {
        submitMax: env.ABSTRACTS_SUBMIT_RATE_LIMIT_MAX,
        editMax: env.ABSTRACTS_EDIT_RATE_LIMIT_MAX,
        readMax: env.ABSTRACTS_READ_RATE_LIMIT_MAX,
        windowMs: parseRateLimitWindowMs(env.ABSTRACTS_RATE_LIMIT_WINDOW) ?? 60_000,
      },
    },
    integrations,
    firebase: integrations.firebase,
    storage: integrations.storage,
    r2: integrations.r2,
    email: integrations.email,
    certificates: integrations.certificates,
    networking: integrations.networking,
    publicFormsUrl: integrations.publicFormsUrl,
    publicLinkAllowedOrigins: parseOriginList(env.PUBLIC_LINK_ALLOWED_ORIGINS) ?? [],
    urls: {
      adminAppUrl: env.ADMIN_APP_URL,
    },
    realtime: {
      disabled: env.REALTIME_DISABLED,
      heartbeatMs: env.SSE_HEARTBEAT_MS,
      clientRetryMs: env.SSE_CLIENT_RETRY_MS,
    },
  };
}

export type AppConfig = ReturnType<typeof parseAppConfig>;
