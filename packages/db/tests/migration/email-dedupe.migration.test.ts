import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { assertSafeTestDatabaseUrl, dbTestsEnabled } from "../helpers/test-env";

// Ownership note: schema.migration.test.ts (0000/0001 assertions) belongs to
// another agent; this file only covers 0003_email_fixes.sql (H6 dedupe column
// + index), applied on top of the same migration set.

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

function migrationFiles(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(`${MIGRATIONS_DIR}/${name}`, "utf8"),
    }));
}

function scratchUrl(base: string): { url: string; dbName: string; adminUrl: string } {
  const parsed = new URL(base);
  const baseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const dbName = `${baseName}_mig_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new URL(base);
  admin.pathname = "/postgres";
  const scratch = new URL(base);
  scratch.pathname = `/${dbName}`;
  return { url: scratch.toString(), dbName, adminUrl: admin.toString() };
}

describe.runIf(dbTestsEnabled())("migration tier: 0003_email_fixes (H6 dedupe)", () => {
  let dbName: string;
  let adminUrl: string;
  let client: Client;

  beforeAll(async () => {
    const scratch = scratchUrl(process.env.TEST_DATABASE_URL as string);
    dbName = scratch.dbName;
    adminUrl = scratch.adminUrl;
    const url = scratch.url;
    assertSafeTestDatabaseUrl(url);

    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();

    client = new Client({ connectionString: url });
    await client.connect();
    for (const { sql } of migrationFiles()) {
      await client.query(sql);
    }
  }, 60000);

  afterAll(async () => {
    if (client) await client.end();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end();
  });

  it("applies 0003_email_fixes.sql", () => {
    expect(migrationFiles().map((f) => f.name)).toContain("0003_email_fixes.sql");
  });

  it("adds email_logs.dedupe_key as a nullable text column", async () => {
    const { rows } = await client.query<{
      is_nullable: string;
      data_type: string;
    }>(
      `SELECT is_nullable, data_type FROM information_schema.columns
       WHERE table_name = 'email_logs' AND column_name = 'dedupe_key'`,
    );
    expect(rows[0]?.data_type).toBe("text");
    expect(rows[0]?.is_nullable).toBe("YES");
  });

  it("creates the partial unique dedupe index scoped to active statuses", async () => {
    const { rows } = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'email_logs_dedupe_key_active_key'`,
    );
    expect(rows).toHaveLength(1);
    const def = rows[0].indexdef;
    expect(def).toContain("UNIQUE");
    expect(def).toContain("dedupe_key");
    expect(def).toMatch(/WHERE/i);
    expect(def).toContain("QUEUED");
  });

  it("rejects a second active row with the same dedupe_key, allows a distinct one", async () => {
    const insert = (id: string, dedupeKey: string) =>
      client.query(
        `INSERT INTO "email_logs"
           ("id", "recipient_email", "subject", "status", "dedupe_key", "updated_at")
         VALUES ($1, 'a@x.com', 'S', 'QUEUED', $2, now())`,
        [id, dedupeKey],
      );

    await insert("log-a", "outbox:evt-1");
    await expect(insert("log-b", "outbox:evt-1")).rejects.toThrow(
      /duplicate key value/i,
    );

    // A distinct dedupe_key is unaffected.
    await insert("log-c", "outbox:evt-2");
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "email_logs" WHERE "dedupe_key" LIKE 'outbox:%'`,
    );
    expect(Number(rows[0].n)).toBe(2);
  });
});
