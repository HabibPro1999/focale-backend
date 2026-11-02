import { describe, expect, it } from "vitest";
import { envKeyMeta } from "./env-meta";
import { APP_ENV_SHAPE, envShape, envObject, integrationsEnvObject } from "./app-env-schema";

describe("shared environment field schemas", () => {
  it("shares each field instance between documented, strict and lenient shapes", () => {
    expect(APP_ENV_SHAPE).toBe(envShape);
    for (const [key, field] of Object.entries(envShape)) {
      expect(envObject.shape[key as keyof typeof envShape], key).toBe(field);
    }
    for (const [key, field] of Object.entries(integrationsEnvObject.shape)) {
      if (key !== "FIREBASE_PROJECT_ID") {
        expect(field, key).toBe(envShape[key as keyof typeof envShape]);
      }
    }
  });

  it("changes only Firebase project optionality and keeps its metadata and every key in order", () => {
    const field = integrationsEnvObject.shape.FIREBASE_PROJECT_ID;
    expect(envShape.FIREBASE_PROJECT_ID.safeParse(undefined).success).toBe(false);
    expect(field.safeParse(undefined)).toMatchObject({ success: true, data: undefined });
    expect(envKeyMeta(field)).toEqual(envKeyMeta(envShape.FIREBASE_PROJECT_ID));
    expect(Object.keys(integrationsEnvObject.shape)).toEqual([
      "NODE_ENV",
      "FIREBASE_PROJECT_ID",
      "FIREBASE_STORAGE_BUCKET",
      "FIREBASE_SERVICE_ACCOUNT",
      "FIREBASE_AUTH_LOOKUP_FALLBACK",
      "FIREBASE_WEB_API_KEY",
      "STORAGE_PROVIDER",
      "R2_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_BUCKET",
      "R2_PUBLIC_URL",
      "EMAIL_PROVIDER",
      "EMAIL_FROM_EMAIL",
      "EMAIL_FROM_NAME",
      "SENDGRID_API_KEY",
      "SENDGRID_WEBHOOK_PUBLIC_KEY",
      "SENDGRID_FROM_EMAIL",
      "SENDGRID_FROM_NAME",
      "SENDGRID_DOMAIN_READ_API_KEY",
      "RESEND_API_KEY",
      "RESEND_WEBHOOK_SECRET",
      "RESEND_DOMAIN_READ_API_KEY",
      "CERTIFICATE_FONT_PATH",
      "CERTIFICATE_BOLD_FONT_PATH",
      "PUBLIC_FORMS_URL",
      "NETWORKING_DISABLED",
      "PUBLIC_NETWORKING_URL",
      "NETWORKING_TOKEN_SECRET",
      "NETWORKING_KEYS",
      "NETWORKING_KEYRING_WRITE_V1",
      "NETWORKING_EMBEDDING_API_KEY",
      "OPENAI_API_KEY",
      "NETWORKING_EMBEDDING_MODEL",
      "NETWORKING_EMBEDDING_BASE_URL",
      "NETWORKING_EMBEDDING_BATCH_SIZE",
      "NETWORKING_EMBEDDING_BATCHES_PER_TICK",
      "NETWORKING_EMBEDDING_CONCURRENCY",
      "NETWORKING_DELIVERY_BATCH_SIZE",
      "NETWORKING_DELIVERY_CONCURRENCY",
      "NETWORKING_DELIVERY_OTP_LANES",
      "NETWORKING_EMAIL_RATE_PER_SECOND",
      "NETWORKING_VAPID_PUBLIC_KEY",
      "NETWORKING_VAPID_PRIVATE_KEY",
      "NETWORKING_VAPID_SUBJECT",
      "NETWORKING_EMAIL_SENDERS",
    ]);
  });
});
