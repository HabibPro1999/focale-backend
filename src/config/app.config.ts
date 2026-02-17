import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    PORT: z.coerce.number().default(3000),
    DATABASE_URL: z.string().url(),
    CORS_ORIGIN: z.string().default("http://localhost:8080"),
    // Alerting
    ALERT_WEBHOOK_URL: z.string().url().optional(),
    // Firebase
    FIREBASE_PROJECT_ID: z.string(),
    FIREBASE_STORAGE_BUCKET: z.string().optional(),
    // Firebase service account JSON (for cloud deployments)
    FIREBASE_SERVICE_ACCOUNT: z.string().optional(),
    // Storage Provider
    STORAGE_PROVIDER: z.enum(["firebase", "r2"]).default("firebase"),
    // Cloudflare R2
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_BUCKET: z.string().optional(),
    R2_PUBLIC_URL: z.string().optional(),
  })
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
    { message: "R2 credentials required when STORAGE_PROVIDER=r2" },
  );

const env = envSchema.parse(process.env);

export const config = Object.freeze({
  NODE_ENV: env.NODE_ENV,
  PORT: env.PORT,
  DATABASE_URL: env.DATABASE_URL,
  CORS_ORIGIN: env.CORS_ORIGIN,
  isDevelopment: env.NODE_ENV === "development",
  isProduction: env.NODE_ENV === "production",
  isTest: env.NODE_ENV === "test",
  alertWebhookUrl: env.ALERT_WEBHOOK_URL,
  database: Object.freeze({
    poolSize: env.NODE_ENV === "production" ? 20 : 5,
  }),
  security: Object.freeze({
    rateLimit: Object.freeze({
      max: env.NODE_ENV === "production" ? 100 : 1000,
      timeWindow: "1 minute",
    }),
  }),
  firebase: Object.freeze({
    projectId: env.FIREBASE_PROJECT_ID,
    storageBucket: env.FIREBASE_STORAGE_BUCKET,
    serviceAccount: env.FIREBASE_SERVICE_ACCOUNT,
  }),
  storage: Object.freeze({
    provider: env.STORAGE_PROVIDER,
  }),
  r2: Object.freeze({
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
    publicUrl: env.R2_PUBLIC_URL,
  }),
});
