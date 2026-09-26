import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScratchDatabase } from "@app/db/testing";
import { createScratchDatabase } from "@app/db/testing";
import { splitMigrationStatements } from "../../src/migrator/migration";
import { dbTestsEnabled } from "../helpers/test-env";
import { dbTestSetupTimeoutMs } from "../../vitest.shared";

// 3.8: 0032 adds the render image columns to certificate_templates, empty on
// existing rows (the renderer falls back to the original image until the
// backfill script fills them).
describe.runIf(dbTestsEnabled())("migration tier: certificate render image (0032)", () => {
  let scratch: ScratchDatabase;

  async function columns(): Promise<Map<string, { type: string; nullable: string }>> {
    const { rows } = await scratch.client.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'certificate_templates'
         AND column_name IN ('render_image_key', 'render_image_width', 'render_image_height')`,
    );
    return new Map(rows.map((row) => [row.column_name, { type: row.data_type, nullable: row.is_nullable }]));
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase({ label: "certificate_render_image", to: "0031" });
    await scratch.client.query(`
      INSERT INTO clients (id, name, updated_at) VALUES ('cli-1', 'Client', now());
      INSERT INTO events (id, client_id, name, slug, start_date, end_date, updated_at)
      VALUES ('evt-1', 'cli-1', 'Event', 'event', now(), now(), now());
      INSERT INTO certificate_templates
        (id, event_id, name, template_url, template_width, template_height, updated_at)
      VALUES ('tpl-1', 'evt-1', 'Cert', 'https://cdn.example.com/evt-1/certificates/tpl-1.png', 1200, 850, now());
    `);
  }, dbTestSetupTimeoutMs());
  afterAll(async () => scratch?.close());

  it("before 0032, templates have no render image columns", async () => {
    expect(await columns()).toEqual(new Map());
  });

  it("0032 adds the three nullable columns, NULL on existing templates", async () => {
    expect((await scratch.applyMigrations({ to: "0032" })).applied).toEqual(["0032"]);

    const added = await columns();
    expect(added.get("render_image_key")?.type).toMatch(/^(text|character varying)$/i);
    expect(added.get("render_image_width")?.type).toMatch(/^(integer|bigint)$/i);
    expect(added.get("render_image_height")?.type).toMatch(/^(integer|bigint)$/i);
    for (const column of added.values()) expect(column.nullable).toBe("YES");

    const { rows } = await scratch.client.query(
      `SELECT render_image_key, render_image_width, render_image_height
       FROM certificate_templates WHERE id = 'tpl-1'`,
    );
    expect(rows).toEqual([{ render_image_key: null, render_image_width: null, render_image_height: null }]);

    await scratch.client.query(
      `UPDATE certificate_templates
       SET render_image_key = 'evt-1/certificates/tpl-1-u-render.jpg',
           render_image_width = 1200, render_image_height = 850
       WHERE id = 'tpl-1'`,
    );
  });

  it("ends in the same state when its statements run again (crash recovery), data kept", async () => {
    const source = await readFile(
      resolve(__dirname, "../../migrations/0032_certificate_render_image.sql"),
      "utf8",
    );
    for (const statement of splitMigrationStatements(source)) await scratch.client.query(statement);

    expect([...(await columns()).keys()].sort()).toEqual([
      "render_image_height",
      "render_image_key",
      "render_image_width",
    ]);
    // Compared in SQL: CockroachDB's integer is INT8, which node-pg returns as a string.
    const { rows } = await scratch.client.query<{ key: string; sized: boolean }>(
      `SELECT render_image_key AS key,
              (render_image_width = 1200 AND render_image_height = 850) AS sized
       FROM certificate_templates WHERE id = 'tpl-1'`,
    );
    expect(rows).toEqual([{ key: "evt-1/certificates/tpl-1-u-render.jpg", sized: true }]);
  });
});
