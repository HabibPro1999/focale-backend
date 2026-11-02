import { z } from "zod";
import {
  envShape,
  envObject,
  integrationsEnvObject,
  type ParsedEnv,
  type IntegrationsEnv,
} from "./app-env-schema";
import { crossKeyIssues, type ConfigIssue } from "./config-rules";
import { dbRuntimeSettingsFrom } from "./db-settings";
import {
  DEFAULT_LOCAL_ORIGIN,
  canonicalOrigin,
  listEntries,
  parseOriginList,
  parseRateLimitWindowMs,
} from "./env-values";
import type { NetworkingKeyEntry } from "./networking-keys";
import { resolveTrustProxy } from "./trust-proxy";

// Public names defined in the leaves, re-exported so this module stays the
// config entry point (the Zod objects stay internal).
export {
  APP_ENV_SHAPE,
  JSONB_VALIDATION_MODES,
  resolveJsonbValidationMode,
  type JsonbValidationMode,
} from "./app-env-schema";
export { DEFAULT_LOCAL_ORIGIN, parseRateLimitWindowMs } from "./env-values";
export type { ConfigIssue } from "./config-rules";

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
  /** Unset when NETWORKING_DISABLED=true or not configured. The keyring's `legacy` key. */
  tokenSecret?: string;
  /** NETWORKING_KEYS (first entry current); empty when NETWORKING_DISABLED=true or unset. */
  keys: NetworkingKeyEntry[];
  /** NETWORKING_KEYRING_WRITE_V1. */
  keyringWriteV1: boolean;
  embedding: {
    apiKey?: string;
    model: string;
    baseUrl: string;
    batchSize: number;
    batchesPerTick: number;
    concurrency: number;
  };
  /** Delivery worker lanes and the email token bucket (NETWORKING_DELIVERY_*, NETWORKING_EMAIL_RATE_PER_SECOND). */
  delivery: {
    batchSize: number;
    concurrency: number;
    otpLanes: number;
    emailRatePerSecond: number;
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
      keys: env.NETWORKING_DISABLED ? [] : env.NETWORKING_KEYS ?? [],
      keyringWriteV1: env.NETWORKING_KEYRING_WRITE_V1,
      embedding: {
        apiKey: env.NETWORKING_EMBEDDING_API_KEY ?? env.OPENAI_API_KEY,
        model: env.NETWORKING_EMBEDDING_MODEL,
        baseUrl: env.NETWORKING_EMBEDDING_BASE_URL,
        batchSize: env.NETWORKING_EMBEDDING_BATCH_SIZE,
        batchesPerTick: env.NETWORKING_EMBEDDING_BATCHES_PER_TICK,
        concurrency: env.NETWORKING_EMBEDDING_CONCURRENCY,
      },
      delivery: {
        batchSize: env.NETWORKING_DELIVERY_BATCH_SIZE,
        concurrency: env.NETWORKING_DELIVERY_CONCURRENCY,
        otpLanes: env.NETWORKING_DELIVERY_OTP_LANES,
        emailRatePerSecond: env.NETWORKING_EMAIL_RATE_PER_SECOND,
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
  const isProduction = env.NODE_ENV === "production";
  const integrations = integrationsSliceFrom(env);
  const corsEntries = listEntries(env.CORS_ORIGIN);

  return {
    ...env,
    isProduction,
    // Legacy: workers run unless RUN_WORKERS is the literal string "false".
    runWorkers: env.RUN_WORKERS !== "false",
    lifecycle: {
      shutdownGraceMs: env.SHUTDOWN_GRACE_MS,
      workerHeartbeatFile: env.WORKER_HEARTBEAT_FILE,
      serviceName: env.RENDER_SERVICE_NAME ?? "focale-worker",
    },
    // Same values the db client derives at pool construction.
    database: dbRuntimeSettingsFrom(env, env.NODE_ENV),
    http: {
      /** Fastify `trustProxy`: explicit peer list, or false (socket address). */
      trustProxy: resolveTrustProxy(env.TRUST_PROXY),
      cors: {
        /** `*` entry, accepted outside production only. */
        allowAnyOrigin: corsEntries.includes("*"),
        // Cross-key validation already established that every non-wildcard entry is an origin.
        origins: [...new Set(corsEntries.filter((entry) => entry !== "*").map((entry) => canonicalOrigin(entry)!))],
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
    networking: integrations.networking,
    publicLinkAllowedOrigins: parseOriginList(env.PUBLIC_LINK_ALLOWED_ORIGINS) ?? [],
    urls: {
      adminAppUrl: env.ADMIN_APP_URL,
    },
    exports: {
      maxConcurrency: env.EXPORT_MAX_CONCURRENCY,
      maxQueued: env.EXPORT_MAX_QUEUED,
    },
    realtime: {
      disabled: env.REALTIME_DISABLED,
      heartbeatMs: env.SSE_HEARTBEAT_MS,
      clientRetryMs: env.SSE_CLIENT_RETRY_MS,
    },
  };
}

export type AppConfig = ReturnType<typeof parseAppConfig>;
