import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { assertSafeTestDatabaseUrl, dbTestsEnabled } from "../helpers/test-env";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

// Partial-unique indexes drizzle-kit cannot express + the GIN index, applied by
// 0001_raw_indexes.sql. Names are load-bearing (app code matches on them).
// abstracts_event_id_code_number_key deliberately excluded (N2): 0001 must not
// recreate it, and 0002 drops it defensively for already-migrated DBs — see
// the dedicated assertion below.
const RAW_INDEX_NAMES = [
  "email_template_registration_uniq",
  "email_template_abstract_uniq",
  "abstracts_event_id_author_email_normalized_key",
  "email_logs_registration_trigger_active_key",
  "email_logs_abstract_submission_ack_active_key",
  "email_logs_template_recipient_trigger_active_key",
  "outbox_events_dedupe_key_key",
];
const GIN_INDEX_NAME = "registrations_access_type_ids_inverted_idx";

function migrationFiles(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(`${MIGRATIONS_DIR}/${name}`, "utf8"),
    }));
}

/** Build a scratch DB URL from the safe base, keeping the disposable-name proof. */
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

describe.runIf(dbTestsEnabled())("migration tier: apply + introspect", () => {
  let dbName: string;
  let adminUrl: string;
  let client: Client;

  beforeAll(async () => {
    // Computed here (not at collection time) so the ungated suite skips cleanly
    // without touching an undefined TEST_DATABASE_URL.
    const scratch = scratchUrl(process.env.TEST_DATABASE_URL as string);
    dbName = scratch.dbName;
    adminUrl = scratch.adminUrl;
    const url = scratch.url;
    assertSafeTestDatabaseUrl(url);

    // Create the scratch DB from the maintenance connection.
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();

    // Apply every migration file in lexical order (0000_init then 0001_raw_indexes).
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

  it("applies at least the init + raw-index migrations", () => {
    const files = migrationFiles().map((f) => f.name);
    expect(files).toContain("0000_init.sql");
    expect(files).toContain("0001_raw_indexes.sql");
  });

  it("creates exactly 29 base tables", async () => {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    expect(Number(rows[0].n)).toBe(29);
  });

  it("creates exactly 19 enum types", async () => {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public' AND t.typtype = 'e'`,
    );
    expect(Number(rows[0].n)).toBe(19);
  });

  it("creates the 7 partial-unique indexes + GIN index by exact name", async () => {
    const { rows } = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const names = new Set(rows.map((r) => r.indexname));
    for (const name of RAW_INDEX_NAMES) expect(names.has(name)).toBe(true);
    expect(names.has(GIN_INDEX_NAME)).toBe(true);

    const { rows: gin } = await client.query<{ amname: string }>(
      `SELECT am.amname FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
       JOIN pg_am am ON am.oid = c.relam
       WHERE c.relname = $1`,
      [GIN_INDEX_NAME],
    );
    expect(gin[0]?.amname).toBe("gin");
  });

  it("N2: does not recreate abstracts_event_id_code_number_key (code_number is not unique per event)", async () => {
    const { rows } = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const names = new Set(rows.map((r) => r.indexname));
    expect(names.has("abstracts_event_id_code_number_key")).toBe(false);
  });

  it("L1: creates the abstract_book_jobs one-active-job-per-event partial-unique index", async () => {
    const { rows } = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const names = new Set(rows.map((r) => r.indexname));
    expect(names.has("abstract_book_jobs_event_id_active_key")).toBe(true);
  });

  it("spot-checks column types: companion_price int8, text ids, updated_at no default", async () => {
    const { rows } = await client.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      column_default: string | null;
    }>(
      `SELECT table_name, column_name, data_type, column_default
       FROM information_schema.columns
       WHERE (table_name = 'event_access' AND column_name = 'companion_price')
          OR (table_name = 'clients' AND column_name IN ('id', 'updated_at'))`,
    );
    const by = (t: string, c: string) =>
      rows.find((r) => r.table_name === t && r.column_name === c);

    expect(by("event_access", "companion_price")?.data_type).toBe("bigint");
    expect(by("clients", "id")?.data_type).toBe("text");
    expect(by("clients", "updated_at")?.data_type).toBe("timestamp without time zone");
    expect(by("clients", "updated_at")?.column_default).toBeNull();
  });
});
