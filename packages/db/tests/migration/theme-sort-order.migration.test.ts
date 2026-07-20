import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { assertSafeTestDatabaseUrl, dbTestsEnabled } from "../helpers/test-env";

// Covers 0006_abstract_themes_sort_order_active_unique.sql only: the seeded
// duplicate repair (theme with issued codes keeps its slot) + the partial
// unique index backstop. Earlier migrations are asserted elsewhere.

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));
const TARGET = "0006_abstract_themes_sort_order_active_unique.sql";

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

const SEED = `
INSERT INTO "clients" ("id", "name", "updated_at") VALUES ('cl1', 'Client', now());
INSERT INTO "events" ("id", "client_id", "name", "slug", "start_date", "end_date", "updated_at")
  VALUES ('ev1', 'cl1', 'Event', 'event', now(), now(), now());
INSERT INTO "abstract_config" ("id", "event_id", "updated_at") VALUES ('cfg1', 'ev1', now());
-- Duplicate slot 2 among ACTIVE themes: t-coded has issued codes (counter
-- last_value > 0) and must keep the slot; t-loser must be bumped above the
-- config max (5). t-inactive shares the slot but is inactive: untouched.
-- t-max holds the max sortOrder. t-loser is older than t-coded, proving the
-- issued-codes criterion outranks created_at.
INSERT INTO "abstract_themes" ("id", "config_id", "label", "sort_order", "active", "created_at", "updated_at") VALUES
  ('t-coded',    'cfg1', 'Coded',    2, true,  '2026-02-01', now()),
  ('t-loser',    'cfg1', 'Loser',    2, true,  '2026-01-01', now()),
  ('t-inactive', 'cfg1', 'Inactive', 2, false, '2026-01-01', now()),
  ('t-max',      'cfg1', 'Max',      5, true,  '2026-01-01', now());
INSERT INTO "abstract_code_counters" ("id", "event_id", "theme_id", "final_type", "last_value", "updated_at")
  VALUES ('cnt1', 'ev1', 't-coded', 'ORAL_COMMUNICATION', 7, now());
`;

describe.runIf(dbTestsEnabled())("migration tier: 0006 theme sortOrder uniqueness", () => {
  let dbName: string;
  let adminUrl: string;
  let client: Client;

  beforeAll(async () => {
    const scratch = scratchUrl(process.env.TEST_DATABASE_URL as string);
    dbName = scratch.dbName;
    adminUrl = scratch.adminUrl;
    assertSafeTestDatabaseUrl(scratch.url);

    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();

    client = new Client({ connectionString: scratch.url });
    await client.connect();
    // Apply everything below 0006, seed the duplicate state, then apply 0006.
    for (const { name, sql } of migrationFiles()) {
      if (name === TARGET) await client.query(SEED);
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

  it("keeps the coded theme in its slot and bumps the other duplicate above max", async () => {
    const { rows } = await client.query<{ id: string; sort_order: number }>(
      `SELECT "id", "sort_order" FROM "abstract_themes" ORDER BY "id"`,
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.sort_order]));
    expect(byId["t-coded"]).toBe(2); // issued codes outrank older created_at
    expect(byId["t-loser"]).toBe(6); // max(5) + 1
    expect(byId["t-inactive"]).toBe(2); // inactive: untouched
    expect(byId["t-max"]).toBe(5);
  });

  it("rejects a new ACTIVE duplicate via the partial unique index", async () => {
    await expect(
      client.query(
        `INSERT INTO "abstract_themes" ("id", "config_id", "label", "sort_order", "active", "updated_at")
         VALUES ('t-new', 'cfg1', 'New', 2, true, now())`,
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("still allows an INACTIVE theme in an occupied slot", async () => {
    await expect(
      client.query(
        `INSERT INTO "abstract_themes" ("id", "config_id", "label", "sort_order", "active", "updated_at")
         VALUES ('t-new-inactive', 'cfg1', 'NewInactive', 2, false, now())`,
      ),
    ).resolves.toBeTruthy();
  });
});
