import { config as loadEnvFile } from "dotenv";
import { existsSync } from "fs";
import { resolve } from "path";

const UNIT_DATABASE_URL =
  "postgresql://test_user:test_password@localhost:5432/focale_unit_test";

const optionalSecretKeys = [
  "FIREBASE_SERVICE_ACCOUNT",
  "SENDGRID_API_KEY",
  "SENDGRID_WEBHOOK_PUBLIC_KEY",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "R2_PUBLIC_URL",
];

function loadOptionalEnvFile(fileName: string): void {
  const envPath = resolve(process.cwd(), fileName);
  if (existsSync(envPath)) {
    loadEnvFile({ path: envPath, quiet: true });
  }
}

function clearNetworkSecretEnv(): void {
  for (const key of optionalSecretKeys) {
    delete process.env[key];
  }
}

function applyCommonSafeDefaults(): void {
  process.env.PORT ??= "0";
  process.env.CORS_ORIGIN ??= "http://localhost:8080";
  process.env.FIREBASE_PROJECT_ID = "test-project";
  process.env.FIREBASE_STORAGE_BUCKET = "test-bucket";
  process.env.STORAGE_PROVIDER = "firebase";
  process.env.SENDGRID_FROM_EMAIL = "noreply@example.test";
  process.env.SENDGRID_FROM_NAME = "Test Sender";
  process.env.PUBLIC_FORMS_URL ??= "http://localhost:8080/forms";
  process.env.REALTIME_DISABLED ??= "false";
  process.env.SSE_HEARTBEAT_MS ??= "25000";
  process.env.SSE_CLIENT_RETRY_MS ??= "15000";
  process.env.ABSTRACTS_SUBMIT_RATE_LIMIT_MAX ??= "1000";
  process.env.ABSTRACTS_EDIT_RATE_LIMIT_MAX ??= "1000";
  process.env.ABSTRACTS_READ_RATE_LIMIT_MAX ??= "1000";
  process.env.ABSTRACTS_RATE_LIMIT_WINDOW ??= "1 minute";
}

function failTestEnv(message: string): never {
  throw new Error(`[test-env] ${message}`);
}

export function assertSafeTestDatabaseUrl(databaseUrl: string): void {
  let parsed: URL;

  try {
    parsed = new URL(databaseUrl);
  } catch {
    failTestEnv("TEST database URL is not a valid URL.");
  }

  if (!["postgresql:", "postgres:"].includes(parsed.protocol)) {
    failTestEnv("TEST database URL must use a PostgreSQL-compatible scheme.");
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName) {
    failTestEnv("TEST database URL must include a database name.");
  }

  if (!/(test|ci)/i.test(databaseName)) {
    failTestEnv(
      "TEST database name must clearly contain 'test' or 'ci' to prove it is disposable.",
    );
  }

  if (/(^|[-_.])(prod|production|main)([-_.]|$)/i.test(databaseName)) {
    failTestEnv("Refusing to use a production-like TEST database name.");
  }

  if (/(^|[-_.])(prod|production)([-_.]|$)/i.test(parsed.hostname)) {
    failTestEnv("Refusing to use a production-like TEST database host.");
  }
}

export function loadUnitEnv(): void {
  process.env.NODE_ENV = "test";
  loadOptionalEnvFile(".env.test");
  process.env.NODE_ENV = "test";

  clearNetworkSecretEnv();
  applyCommonSafeDefaults();

  // Unit tests always use Prisma mocks, so keep DATABASE_URL dummy and local.
  process.env.DATABASE_URL = UNIT_DATABASE_URL;
}

export function loadDbEnv(): void {
  loadOptionalEnvFile(".env.test.db");

  process.env.NODE_ENV ??= "test";
  if (process.env.NODE_ENV !== "test") {
    failTestEnv("DB test tiers require NODE_ENV=test.");
  }

  if (process.env.ALLOW_DB_TESTS !== "1") {
    failTestEnv("DB test tiers are opt-in. Set ALLOW_DB_TESTS=1 to continue.");
  }

  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) {
    failTestEnv("DB test tiers require TEST_DATABASE_URL.");
  }

  assertSafeTestDatabaseUrl(testDatabaseUrl);
  clearNetworkSecretEnv();
  applyCommonSafeDefaults();
  process.env.DATABASE_URL = testDatabaseUrl;
}

export function loadMigrationEnv(): void {
  loadOptionalEnvFile(".env.test.migration");

  process.env.NODE_ENV ??= "test";
  if (process.env.NODE_ENV !== "test") {
    failTestEnv("Migration test tier requires NODE_ENV=test.");
  }

  if (process.env.ALLOW_DB_TESTS !== "1") {
    failTestEnv(
      "Migration tests are opt-in. Set ALLOW_DB_TESTS=1 to continue.",
    );
  }

  const migrationDatabaseUrl = process.env.TEST_MIGRATION_DATABASE_URL;
  if (!migrationDatabaseUrl) {
    failTestEnv("Migration test tier requires TEST_MIGRATION_DATABASE_URL.");
  }

  assertSafeTestDatabaseUrl(migrationDatabaseUrl);
  clearNetworkSecretEnv();
  applyCommonSafeDefaults();
  process.env.DATABASE_URL = migrationDatabaseUrl;
}
