import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScratchDatabase } from "@app/db/testing";
import { createScratchDatabase, dbTestsEnabled } from "@app/db/testing";
import { splitMigrationStatements } from "../../src/migrator/migration";
import { dbTestSetupTimeoutMs } from "../../../vitest.shared";

// 0042 creates badge_templates (expand-only): an event's badges, deleted with it.
describe.runIf(dbTestsEnabled())("migration tier: badge templates (0042)", () => {
  let scratch: ScratchDatabase;

  async function tableExists(): Promise<boolean> {
    const { rows } = await scratch.client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'badge_templates'`,
    );
    return rows.length === 1;
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase({ label: "badge_templates", to: "0041" });
    await scratch.client.query(`
      INSERT INTO clients (id, name, updated_at) VALUES ('cli-1', 'Client', now());
      INSERT INTO events (id, client_id, name, slug, start_date, end_date, updated_at)
      VALUES ('evt-1', 'cli-1', 'Event', 'event', now(), now(), now()),
             ('evt-2', 'cli-1', 'Other', 'other', now(), now(), now());
    `);
  }, dbTestSetupTimeoutMs());
  afterAll(async () => scratch?.close());

  it("before 0042, there is no badge_templates table", async () => {
    expect(await tableExists()).toBe(false);
  });

  it("0042 creates the table: mm sizes kept exactly, zones default to an empty list", async () => {
    expect((await scratch.applyMigrations({ to: "0042" })).applied).toEqual(["0042"]);
    expect(await tableExists()).toBe(true);

    await scratch.client.query(`
      INSERT INTO badge_templates (id, event_id, name, width_mm, height_mm, updated_at)
      VALUES ('bdg-1', 'evt-1', 'Attendee', 85.6, 54, now()),
             ('bdg-2', 'evt-2', 'Staff', 90, 55, now());
    `);
    // Compared in SQL: node-pg returns numeric as a string, CockroachDB's integer as INT8.
    const { rows } = await scratch.client.query(
      `SELECT width_mm = 85.6 AS width_ok, height_mm = 54 AS height_ok, zones,
              background_url, render_image_key, deleted_at
       FROM badge_templates WHERE id = 'bdg-1'`,
    );
    expect(rows).toEqual([
      { width_ok: true, height_ok: true, zones: [], background_url: null, render_image_key: null, deleted_at: null },
    ]);

    const { rows: indexes } = await scratch.client.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'badge_templates' AND indexname = 'badge_templates_event_id_idx'`,
    );
    expect(indexes).toHaveLength(1);
  });

  it("deleting the event deletes its badges", async () => {
    await scratch.client.query(`DELETE FROM events WHERE id = 'evt-2'`);
    const { rows } = await scratch.client.query(`SELECT id FROM badge_templates ORDER BY id`);
    expect(rows).toEqual([{ id: "bdg-1" }]);
  });

  it("ends in the same state when its statements run again (crash recovery), data kept", async () => {
    const source = await readFile(resolve(__dirname, "../../migrations/0042_badge_templates.sql"), "utf8");
    for (const statement of splitMigrationStatements(source)) await scratch.client.query(statement);

    const { rows } = await scratch.client.query(`SELECT id, name FROM badge_templates`);
    expect(rows).toEqual([{ id: "bdg-1", name: "Attendee" }]);
  });
});
