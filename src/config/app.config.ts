import { z } from "zod";

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
    // SendGrid
    SENDGRID_API_KEY: z.string().optional(),
    SENDGRID_WEBHOOK_PUBLIC_KEY: z.string().optional(),
    SENDGRID_FROM_EMAIL: z.string().email().optional(),
    SENDGRID_FROM_NAME: z.string().optional(),
    // Storage Provider
    STORAGE_PROVIDER: z.enum(["firebase", "r2"]).default("firebase"),
    // Public URL for forms (used in email links)
    PUBLIC_FORMS_URL: z.string().url().optional(),
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
      if (data.NODE_ENV === "production" && data.SENDGRID_API_KEY) {
        return !!data.SENDGRID_FROM_EMAIL;
      }
      return true;
    },
    {
      message:
        "SENDGRID_FROM_EMAIL required in production when SENDGRID_API_KEY is set",
      path: ["SENDGRID_FROM_EMAIL"],
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

export function parseConfig(source: NodeJS.ProcessEnv) {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new ConfigError(result.error.issues);
  }

  const env = result.data;

  return {
    ...env,
    isDevelopment: env.NODE_ENV === "development",
    isProduction: env.NODE_ENV === "production",
    isTest: env.NODE_ENV === "test",
    database: {
      poolSize: env.NODE_ENV === "production" ? 20 : 5,
    },
    security: {
      rateLimit: {
        max: env.NODE_ENV === "production" ? 100 : 1000,
        timeWindow: "1 minute",
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
    sendgrid: {
      apiKey: env.SENDGRID_API_KEY,
      webhookPublicKey: env.SENDGRID_WEBHOOK_PUBLIC_KEY,
      fromEmail: env.SENDGRID_FROM_EMAIL ?? "noreply@example.com",
      fromName: env.SENDGRID_FROM_NAME ?? "Event Platform",
    },
    publicFormsUrl: env.PUBLIC_FORMS_URL,
    realtime: {
      disabled: env.REALTIME_DISABLED,
      heartbeatMs: env.SSE_HEARTBEAT_MS,
      clientRetryMs: env.SSE_CLIENT_RETRY_MS,
    },
  };
}

export type AppConfig = ReturnType<typeof parseConfig>;

export const config = parseConfig(process.env);
