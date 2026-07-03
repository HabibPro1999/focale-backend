// Real-DB test gating + safety, ported from the legacy tests/helpers/test-env.ts.
// The three real-DB tiers (db, concurrency, migration) are opt-in: they only run
// when ALLOW_DB_TESTS=1 and a TEST_DATABASE_URL is provided. When ungated the
// tiers SKIP cleanly (describe.runIf) rather than failing. When gated but the URL
// looks unsafe (not disposable / prod-like), we throw loudly on purpose.

function failTestEnv(message: string): never {
  throw new Error(`[test-env] ${message}`);
}

/**
 * Ported EXACTLY from legacy. A TEST database URL must be a PostgreSQL-compatible
 * URL whose database name proves it is disposable (contains `test`/`ci`) and does
 * not look production-like in either the database name or the host.
 */
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

/**
 * True when the real-DB tiers are opted in. Missing gate/URL → skip (not fail);
 * a present-but-unsafe URL still throws via assertSafeTestDatabaseUrl in loadDbEnv.
 */
export function dbTestsEnabled(): boolean {
  return (
    process.env.ALLOW_DB_TESTS === "1" && Boolean(process.env.TEST_DATABASE_URL)
  );
}

/** Gate + safety-check + point DATABASE_URL at the disposable test DB. */
export function loadDbEnv(): void {
  process.env.NODE_ENV ??= "test";
  if (process.env.ALLOW_DB_TESTS !== "1") {
    failTestEnv("DB test tiers are opt-in. Set ALLOW_DB_TESTS=1 to continue.");
  }
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) {
    failTestEnv("DB test tiers require TEST_DATABASE_URL.");
  }
  assertSafeTestDatabaseUrl(testDatabaseUrl);
  process.env.DATABASE_URL = testDatabaseUrl;
}

/**
 * Base connection URL for the migration tier's scratch-DB admin work. The
 * migration tier creates+drops its own scratch database, so it only needs a safe
 * base URL (server + credentials) to connect to the `postgres` maintenance DB.
 * Reuses TEST_DATABASE_URL (already safety-checked) so the local run needs a
 * single env var.
 */
export function loadMigrationEnv(): void {
  process.env.NODE_ENV ??= "test";
  if (process.env.ALLOW_DB_TESTS !== "1") {
    failTestEnv("Migration test tier is opt-in. Set ALLOW_DB_TESTS=1 to continue.");
  }
  const base = process.env.TEST_MIGRATION_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!base) {
    failTestEnv(
      "Migration tier requires TEST_DATABASE_URL (or TEST_MIGRATION_DATABASE_URL).",
    );
  }
  assertSafeTestDatabaseUrl(base);
}
