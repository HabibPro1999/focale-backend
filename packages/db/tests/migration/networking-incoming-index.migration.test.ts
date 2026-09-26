import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScratchDatabase } from "@app/db/testing";
import { createScratchDatabase } from "@app/db/testing";
import { splitMigrationStatements } from "../../src/migrator/migration";
import { dbTestsEnabled } from "../helpers/test-env";
import { dbTestSetupTimeoutMs } from "../../vitest.shared";

const INDEX = "networking_interests_incoming_idx";

// 4.9: 0034 adds the partial index behind the keyset "who liked me" list
// (per statement, idempotent). Existing rows need nothing.
describe.runIf(dbTestsEnabled())("migration tier: networking incoming interests index (0034)", () => {
  let scratch: ScratchDatabase;

  async function indexes(): Promise<string[]> {
    const { rows } = await scratch.client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'networking_interests' AND indexname = $1`,
      [INDEX],
    );
    return rows.map((row) => row.indexname);
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase({ label: "networking_incoming_index", to: "0033" });
    await scratch.client.query(`
      INSERT INTO clients (id, name, updated_at) VALUES ('cli-1', 'Client', now());
      INSERT INTO events (id, client_id, name, slug, start_date, end_date, updated_at)
      VALUES ('evt-1', 'cli-1', 'Event', 'event', now(), now(), now());
      INSERT INTO forms (id, event_id, name, schema, updated_at) VALUES ('form-1', 'evt-1', 'Form', '{}', now());
      INSERT INTO registrations (id, event_id, form_id, email, total_amount, price_breakdown, form_data, updated_at)
      VALUES ('reg-1', 'evt-1', 'form-1', 'a@example.test', 0, '{}', '{}', now()),
             ('reg-2', 'evt-1', 'form-1', 'b@example.test', 0, '{}', '{}', now());
      INSERT INTO networking_profiles (id, event_id, registration_id, email, updated_at)
      VALUES ('p-1', 'evt-1', 'reg-1', 'a@example.test', now()), ('p-2', 'evt-1', 'reg-2', 'b@example.test', now());
      INSERT INTO networking_interests (id, event_id, profile_id, target_id, action, updated_at)
      VALUES ('i-1', 'evt-1', 'p-1', 'p-2', 'LIKE', now()), ('i-2', 'evt-1', 'p-2', 'p-1', 'PASS', now());
    `);
  }, dbTestSetupTimeoutMs());
  afterAll(async () => scratch?.close());

  it("before 0034, networking_interests has no incoming index", async () => {
    expect(await indexes()).toEqual([]);
  });

  it("0034 adds the index over existing rows", async () => {
    const { applied } = await scratch.applyMigrations({ to: "0034" });
    expect(applied).toEqual(["0034"]);
    expect(await indexes()).toEqual([INDEX]);
    const { rows } = await scratch.client.query<{ id: string }>(
      `SELECT id FROM networking_interests WHERE event_id = 'evt-1' AND target_id = 'p-2' AND action = 'LIKE'
       ORDER BY created_at DESC, id DESC LIMIT 5`,
    );
    expect(rows.map((row) => row.id)).toEqual(["i-1"]);
  });

  it("ends in the same state when its statements run again (crash recovery)", async () => {
    const source = await readFile(resolve(__dirname, "../../migrations/0034_networking_incoming_interests_index.sql"), "utf8");
    for (const statement of splitMigrationStatements(source)) await scratch.client.query(statement);
    expect(await indexes()).toEqual([INDEX]);
  });
});
