import { z } from "zod";

// Ported wholesale from the legacy Fastify app's src/config/app.config.ts.
// Zod-only lives in contracts (leaf package); both apps import parseAppConfig
// and parse eagerly in their own core/config.ts (fail-fast at boot).
const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    PORT: z.coerce.number().default(3000),
    DATABASE_URL: z.string().url(),
    CORS_ORIGIN: z.string().default("http://localhost:8080"),
    // Firebase
    FIREBASE_PROJECT_ID: z.string(),
    FIREBASE_STORAGE_BUCKET: z.string().optional(),
    // Firebase service account JSON (for cloud deployments)
    FIREBASE_SERVICE_ACCOUNT: z.string().optional(),
    // Application Default Credentials path (alternative firebase-admin cred source)
    GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
    // Email provider selection
    EMAIL_PROVIDER: z.enum(["sendgrid", "resend"]).default("sendgrid"),
    // Shared sender identity (falls back to SENDGRID_FROM_* for back-compat)
    EMAIL_FROM_EMAIL: z.string().email().optional(),
    EMAIL_FROM_NAME: z.string().optional(),
    // SendGrid
    SENDGRID_API_KEY: z.string().optional(),
    SENDGRID_WEBHOOK_PUBLIC_KEY: z.string().optional(),
    SENDGRID_FROM_EMAIL: z.string().email().optional(),
    SENDGRID_FROM_NAME: z.string().optional(),
    // Resend
    RESEND_API_KEY: z.string().optional(),
    RESEND_WEBHOOK_SECRET: z.string().optional(),
    // Storage Provider
    STORAGE_PROVIDER: z.enum(["firebase", "r2"]).default("firebase"),
    // Public URL for forms (used in email links)
    PUBLIC_FORMS_URL: z.string().url().optional(),
    // Admin app base URL — used as the in-app target for Firebase password
    // reset / action handler links. The Firebase Console "Customize action URL"
    // setting should point at `${ADMIN_APP_URL}/auth/action`.
    ADMIN_APP_URL: z.string().url().default("http://localhost:8080"),
    // Cloudflare R2
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_BUCKET: z.string().optional(),
    R2_PUBLIC_URL: z.string().url().optional(),
    // Realtime (SSE)
    REALTIME_DISABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    SSE_HEARTBEAT_MS: z.coerce.number().int().positive().default(25000),
    SSE_CLIENT_RETRY_MS: z.coerce.number().int().positive().default(15000),
    // Abstract public endpoint rate limits (tunable for congress NAT/shared-Wi-Fi bursts)
    ABSTRACTS_SUBMIT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
    ABSTRACTS_EDIT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
    ABSTRACTS_READ_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
    ABSTRACTS_RATE_LIMIT_WINDOW: z.string().default("1 minute"),
    // Certificate PDF font path overrides (fall back to bundled fonts when unset)
    CERTIFICATE_FONT_PATH: z.string().optional(),
    CERTIFICATE_BOLD_FONT_PATH: z.string().optional(),
    // Worker kill switch — legacy semantics: workers run unless the literal "false".
    RUN_WORKERS: z.string().optional(),
    // NEW: explicit log level. When unset, defaults per NODE_ENV (see shaping below).
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .optional(),
  })
  .refine(
    (data) => {
      if (
        data.STORAGE_PROVIDER === "firebase" &&
        !data.FIREBASE_STORAGE_BUCKET
      ) {
        return false;
      }
      return true;
    },
    {
      message:
        "FIREBASE_STORAGE_BUCKET required when STORAGE_PROVIDER=firebase",
      path: ["FIREBASE_STORAGE_BUCKET"],
    },
  )
  .refine(
    (data) => {
      if (data.STORAGE_PROVIDER === "r2") {
        return !!(
          data.R2_ACCOUNT_ID &&
          data.R2_ACCESS_KEY_ID &&
          data.R2_SECRET_ACCESS_KEY &&
          data.R2_BUCKET &&
          data.R2_PUBLIC_URL
        );
      }
      return true;
    },
    {
      message: "R2 credentials required when STORAGE_PROVIDER=r2",
      path: ["STORAGE_PROVIDER"],
    },
  )
  .refine(
    (data) => {
      // SendGrid in production: if a key is configured, a resolvable sender is required.
      if (
        data.NODE_ENV === "production" &&
        data.EMAIL_PROVIDER === "sendgrid" &&
        data.SENDGRID_API_KEY
      ) {
        return !!(data.EMAIL_FROM_EMAIL ?? data.SENDGRID_FROM_EMAIL);
      }
      return true;
    },
    {
      message:
        "A sender email (EMAIL_FROM_EMAIL or SENDGRID_FROM_EMAIL) is required in production when EMAIL_PROVIDER=sendgrid and SENDGRID_API_KEY is set",
      path: ["EMAIL_FROM_EMAIL"],
    },
  )
  .refine(
    (data) => {
      // Resend in production requires an API key.
      if (data.NODE_ENV === "production" && data.EMAIL_PROVIDER === "resend") {
        return !!data.RESEND_API_KEY;
      }
      return true;
    },
    {
      message: "RESEND_API_KEY is required in production when EMAIL_PROVIDER=resend",
      path: ["RESEND_API_KEY"],
    },
  )
  .refine(
    (data) => {
      // Resend in production: a resolvable sender is required once a key is set.
      if (
        data.NODE_ENV === "production" &&
        data.EMAIL_PROVIDER === "resend" &&
        data.RESEND_API_KEY
      ) {
        return !!(data.EMAIL_FROM_EMAIL ?? data.SENDGRID_FROM_EMAIL);
      }
      return true;
    },
    {
      message:
        "A sender email (EMAIL_FROM_EMAIL or SENDGRID_FROM_EMAIL) is required in production when EMAIL_PROVIDER=resend",
      path: ["EMAIL_FROM_EMAIL"],
    },
  )
  .refine(
    (data) => {
      if (
        data.NODE_ENV === "production" &&
        data.ADMIN_APP_URL === "http://localhost:8080"
      ) {
        return false;
      }
      return true;
    },
    {
      message:
        "ADMIN_APP_URL must be set to the deployed admin origin in production (default localhost:8080 not allowed)",
      path: ["ADMIN_APP_URL"],
    },
  );

export class ConfigError extends Error {
  constructor(public issues: z.ZodIssue[]) {
    const details = issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    super(`Environment validation failed:\n${details}`);
    this.name = "ConfigError";
  }
}

export function parseAppConfig(source: NodeJS.ProcessEnv) {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new ConfigError(result.error.issues);
  }

  const env = result.data;
  const isDevelopment = env.NODE_ENV === "development";

  return {
    ...env,
    isDevelopment,
    isProduction: env.NODE_ENV === "production",
    isTest: env.NODE_ENV === "test",
    // LOG_LEVEL is new; keep the legacy NODE_ENV-driven default when unset.
    logLevel: env.LOG_LEVEL ?? (isDevelopment ? "debug" : "info"),
    // Legacy: workers run unless RUN_WORKERS is the literal string "false".
    runWorkers: env.RUN_WORKERS !== "false",
    database: {
      poolSize: env.NODE_ENV === "production" ? 20 : 5,
    },
    security: {
      rateLimit: {
        max: env.NODE_ENV === "production" ? 100 : 1000,
        timeWindow: "1 minute",
      },
      publicAbstracts: {
        submitMax: env.ABSTRACTS_SUBMIT_RATE_LIMIT_MAX,
        editMax: env.ABSTRACTS_EDIT_RATE_LIMIT_MAX,
        readMax: env.ABSTRACTS_READ_RATE_LIMIT_MAX,
        timeWindow: env.ABSTRACTS_RATE_LIMIT_WINDOW,
      },
    },
    firebase: {
      projectId: env.FIREBASE_PROJECT_ID,
      storageBucket: env.FIREBASE_STORAGE_BUCKET,
      serviceAccount: env.FIREBASE_SERVICE_ACCOUNT,
    },
    storage: {
      provider: env.STORAGE_PROVIDER,
    },
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
      fromEmail:
        env.EMAIL_FROM_EMAIL ?? env.SENDGRID_FROM_EMAIL ?? "noreply@example.com",
      fromName: env.EMAIL_FROM_NAME ?? env.SENDGRID_FROM_NAME ?? "Event Platform",
      sendgrid: {
        apiKey: env.SENDGRID_API_KEY,
        webhookPublicKey: env.SENDGRID_WEBHOOK_PUBLIC_KEY,
      },
      resend: {
        apiKey: env.RESEND_API_KEY,
        webhookSecret: env.RESEND_WEBHOOK_SECRET,
      },
    },
    certificates: {
      fontPath: env.CERTIFICATE_FONT_PATH,
      boldFontPath: env.CERTIFICATE_BOLD_FONT_PATH,
    },
    publicFormsUrl: env.PUBLIC_FORMS_URL,
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
