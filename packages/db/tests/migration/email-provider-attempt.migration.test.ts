import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScratchDatabase } from "@app/db/testing";
import { createScratchDatabase } from "@app/db/testing";
import { splitMigrationStatements } from "../../src/migrator/migration";
import { dbTestsEnabled } from "../helpers/test-env";
import { dbTestSetupTimeoutMs } from "../../vitest.shared";

// 3.6: 0028 adds the UNCERTAIN email status (outside a transaction), 0029 the
// provider-attempt marker columns and the (template_id, queued_at) index.
describe.runIf(dbTestsEnabled())("migration tier: email UNCERTAIN status and provider attempt (0028, 0029)", () => {
  let scratch: ScratchDatabase;

  async function rerun(file: string) {
    const source = await readFile(resolve(__dirname, "../../migrations", file), "utf8");
    for (const statement of splitMigrationStatements(source)) await scratch.client.query(statement);
  }

  async function columns(): Promise<Map<string, string>> {
    const { rows } = await scratch.client.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'email_logs'
         AND column_name IN ('provider_attempted_at', 'provider')`,
    );
    return new Map(rows.map((row) => [row.column_name, row.data_type]));
  }

  async function templateIndex(): Promise<string | undefined> {
    const { rows } = await scratch.client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_catalog.pg_indexes
       WHERE schemaname = 'public' AND indexname = 'email_logs_template_id_queued_at_idx'`,
    );
    return rows[0]?.indexdef;
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase({ label: "email_provider_attempt", to: "0027" });
    await scratch.client.query(
      `INSERT INTO email_logs (id, recipient_email, subject, status, updated_at)
       VALUES ('log-1', 'a@x.com', '', 'SENDING', now())`,
    );
  }, dbTestSetupTimeoutMs());
  afterAll(async () => scratch?.close());

  it("before 0028, UNCERTAIN is not an email status", async () => {
    const error = await scratch.client
      .query(`UPDATE email_logs SET status = 'UNCERTAIN' WHERE id = 'log-1'`)
      .then(
        () => undefined,
        (err: unknown) => err as { code?: string },
      );
    // invalid_text_representation (22P02) on both engines: a data exception.
    expect(error?.code).toMatch(/^22/);
  });

  it("0028 adds UNCERTAIN; an existing row can take it", async () => {
    expect((await scratch.applyMigrations({ to: "0028" })).applied).toEqual(["0028"]);
    await scratch.client.query(`UPDATE email_logs SET status = 'UNCERTAIN' WHERE id = 'log-1'`);
    const { rows } = await scratch.client.query<{ status: string }>(`SELECT status::text AS status FROM email_logs`);
    expect(rows).toEqual([{ status: "UNCERTAIN" }]);
  });

  it("0029 adds the marker columns (empty on existing rows) and the template index", async () => {
    expect(await columns()).toEqual(new Map());
    expect((await scratch.applyMigrations({ to: "0029" })).applied).toEqual(["0029"]);
    const added = await columns();
    expect(added.get("provider_attempted_at")).toMatch(/^timestamp without time zone$/i);
    expect(added.get("provider")).toMatch(/^(text|character varying)$/i);
    expect(await templateIndex()).toMatch(/\(template_id(?: ASC)?, queued_at(?: ASC)?\)/i);

    const { rows } = await scratch.client.query<{ attempted: unknown; provider: unknown }>(
      `SELECT provider_attempted_at AS attempted, provider FROM email_logs WHERE id = 'log-1'`,
    );
    expect(rows).toEqual([{ attempted: null, provider: null }]);
    await scratch.client.query(
      `UPDATE email_logs SET provider_attempted_at = now(), provider = 'sendgrid' WHERE id = 'log-1'`,
    );
  });

  it("both end in the same state when their statements run again (crash recovery)", async () => {
    await rerun("0028_email_status_uncertain.sql");
    await rerun("0029_email_provider_attempt.sql");
    expect([...(await columns()).keys()].sort()).toEqual(["provider", "provider_attempted_at"]);
    expect(await templateIndex()).toBeDefined();
    const { rows } = await scratch.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_catalog.pg_enum e
       JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'EmailStatus' AND e.enumlabel = 'UNCERTAIN'`,
    );
    expect(rows).toEqual([{ n: "1" }]);
  });
});
