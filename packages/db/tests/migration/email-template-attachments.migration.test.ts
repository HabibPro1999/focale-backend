import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScratchDatabase } from "@app/db/testing";
import { createScratchDatabase, dbTestsEnabled } from "@app/db/testing";
import { splitMigrationStatements } from "../../src/migrator/migration";
import { dbTestSetupTimeoutMs } from "../../../vitest.shared";

// 0041 adds email_templates.attachments: existing templates attach nothing.
describe.runIf(dbTestsEnabled())("migration tier: email template attachments (0041)", () => {
  let scratch: ScratchDatabase;

  async function attachmentsColumn(): Promise<{ nullable: string } | undefined> {
    const { rows } = await scratch.client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'email_templates'
         AND column_name = 'attachments'`,
    );
    return rows[0] ? { nullable: rows[0].is_nullable } : undefined;
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase({ label: "email_template_attachments", to: "0040" });
    await scratch.client.query(`
      INSERT INTO clients (id, name, updated_at) VALUES ('cli-1', 'Client', now());
      INSERT INTO events (id, client_id, name, slug, start_date, end_date, updated_at)
      VALUES ('evt-1', 'cli-1', 'Event', 'event', now(), now(), now());
      INSERT INTO email_templates (id, client_id, event_id, name, subject, content, category, trigger, updated_at)
      VALUES ('tpl-1', 'cli-1', 'evt-1', 'Welcome', 'Hello', '{"type":"doc","content":[]}', 'AUTOMATIC', 'REGISTRATION_CREATED', now());
    `);
  }, dbTestSetupTimeoutMs());
  afterAll(async () => scratch?.close());

  it("before 0041, templates have no attachments column", async () => {
    expect(await attachmentsColumn()).toBeUndefined();
  });

  it("0041 adds a NOT NULL column, an empty list on existing templates", async () => {
    expect((await scratch.applyMigrations({ to: "0041" })).applied).toEqual(["0041"]);

    expect(await attachmentsColumn()).toEqual({ nullable: "NO" });
    const { rows } = await scratch.client.query(
      `SELECT attachments FROM email_templates WHERE id = 'tpl-1'`,
    );
    expect(rows).toEqual([{ attachments: [] }]);

    await scratch.client.query(
      `UPDATE email_templates SET attachments = '[{"type":"REGISTRATION_QR"}]' WHERE id = 'tpl-1'`,
    );
  });

  it("ends in the same state when its statements run again (crash recovery), data kept", async () => {
    const source = await readFile(
      resolve(__dirname, "../../migrations/0041_email_template_attachments.sql"),
      "utf8",
    );
    for (const statement of splitMigrationStatements(source)) await scratch.client.query(statement);

    const { rows } = await scratch.client.query(
      `SELECT attachments FROM email_templates WHERE id = 'tpl-1'`,
    );
    expect(rows).toEqual([{ attachments: [{ type: "REGISTRATION_QR" }] }]);
  });
});
