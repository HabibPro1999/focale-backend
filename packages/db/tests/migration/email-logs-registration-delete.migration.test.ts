import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScratchDatabase } from "@app/db/testing";
import { createScratchDatabase, dbTestsEnabled } from "@app/db/testing";
import { splitMigrationStatements } from "../../src/migrator/migration";
import { dbTestSetupTimeoutMs } from "../../../vitest.shared";

// 0044: a person whose registration was deleted registers again with the same
// address. Before 0044 the deleted registration's log stayed (SET NULL) and
// the template + recipient + trigger index refused the new registration's log,
// so no pre-registration email went out. 0044 limits that index to logs with
// no registration and makes the registration foreign key ON DELETE CASCADE.
const RECIPIENT_INDEX = "email_logs_template_recipient_trigger_active_key";
const REGISTRATION_INDEX = "email_logs_registration_trigger_active_key";
const FK_NAME = "email_logs_registration_id_registrations_id_fk";

describe.runIf(dbTestsEnabled())("migration tier: email logs on registration delete (0044)", () => {
  let scratch: ScratchDatabase;
  let seq = 0;

  function insertRegistration(id: string, email = "a@x.com") {
    return scratch.client.query(
      `INSERT INTO registrations (id, form_id, event_id, form_data, email, total_amount, price_breakdown, updated_at)
       VALUES ($1, 'form-1', 'evt-1', '{}'::jsonb, $2, 0, '{}'::jsonb, now())`,
      [id, email],
    );
  }

  function insertLog(values: { registrationId: string | null; recipientEmail?: string; trigger?: string; status?: string }) {
    seq += 1;
    return scratch.client.query<{ id: string }>(
      `INSERT INTO email_logs
         (id, trigger, template_id, registration_id, recipient_email, subject, status, updated_at)
       VALUES ($1, $2, 'tpl-1', $3, $4, '', $5, now())
       RETURNING id`,
      [
        `log-${seq}`,
        values.trigger ?? "REGISTRATION_CREATED",
        values.registrationId,
        values.recipientEmail ?? "a@x.com",
        values.status ?? "SENT",
      ],
    );
  }

  async function uniqueViolation(promise: Promise<unknown>): Promise<string | undefined> {
    const error = await promise.then(
      () => undefined,
      (err: unknown) => err as { code?: string; constraint?: string },
    );
    expect(error?.code).toBe("23505");
    return error?.constraint;
  }

  async function logCount(registrationId: string | null): Promise<number> {
    const { rows } = await scratch.client.query<{ n: string }>(
      registrationId === null
        ? `SELECT count(*)::text AS n FROM email_logs WHERE registration_id IS NULL AND recipient_email = 'a@x.com'`
        : `SELECT count(*)::text AS n FROM email_logs WHERE registration_id = $1`,
      registrationId === null ? [] : [registrationId],
    );
    return Number(rows[0].n);
  }

  async function expectMigratedSchema() {
    const { rows: indexes } = await scratch.client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_catalog.pg_indexes
       WHERE schemaname = 'public' AND tablename = 'email_logs'`,
    );
    const definitions = new Map(indexes.map((row) => [row.indexname, row.indexdef]));
    expect(definitions.get(RECIPIENT_INDEX)).toMatch(/UNIQUE/i);
    expect(definitions.get(RECIPIENT_INDEX)).toContain("registration_id IS NULL");
    expect(definitions.get(RECIPIENT_INDEX)).toContain("CERTIFICATE_SENT");
    expect(definitions.has(`${RECIPIENT_INDEX}_rebuild`)).toBe(false);

    const { rows: keys } = await scratch.client.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype::text AS confdeltype FROM pg_catalog.pg_constraint
       WHERE conrelid = 'public.email_logs'::regclass AND contype = 'f'
         AND conname LIKE 'email_logs_registration_id%'`,
    );
    expect(keys).toEqual([{ conname: FK_NAME, confdeltype: "c" }]);
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase({ label: "email_logs_reg_delete", to: "0043" });
    await scratch.client.query(`
      INSERT INTO clients (id, name, updated_at) VALUES ('cli-1', 'Client', now());
      INSERT INTO events (id, client_id, name, slug, start_date, end_date, updated_at)
      VALUES ('evt-1', 'cli-1', 'Event', 'event', now(), now(), now());
      INSERT INTO forms (id, event_id, name, schema, updated_at)
      VALUES ('form-1', 'evt-1', 'Form', '{}'::jsonb, now());
      INSERT INTO email_templates (id, client_id, event_id, name, subject, content, category, trigger, updated_at)
      VALUES ('tpl-1', 'cli-1', 'evt-1', 'Pre-registration', 'S', '{}'::jsonb, 'AUTOMATIC', 'REGISTRATION_CREATED', now());
    `);
  }, dbTestSetupTimeoutMs());
  afterAll(async () => scratch?.close());

  it("before 0044, a deleted registration's log blocks the same address registering again", async () => {
    await insertRegistration("reg-old");
    await insertLog({ registrationId: "reg-old" });
    await scratch.client.query(`DELETE FROM registrations WHERE id = 'reg-old'`);
    expect(await logCount(null)).toBe(1);

    await insertRegistration("reg-new");
    expect(await uniqueViolation(insertLog({ registrationId: "reg-new" }))).toBe(RECIPIENT_INDEX);
  });

  it("narrows the recipient index and cascades the registration foreign key", async () => {
    const result = await scratch.applyMigrations({ to: "0044" });
    expect(result.applied).toEqual(["0044"]);
    await expectMigratedSchema();
  });

  it("keeps the orphaned log and lets the new registration's log in", async () => {
    expect(await logCount(null)).toBe(1);
    await insertLog({ registrationId: "reg-new" });
    expect(await logCount("reg-new")).toBe(1);
  });

  it("still refuses a second active log for one registration and trigger", async () => {
    expect(await uniqueViolation(insertLog({ registrationId: "reg-new" }))).toBe(REGISTRATION_INDEX);
  });

  it("still refuses a second active recipient-only log for one template and trigger", async () => {
    await insertLog({ registrationId: null, recipientEmail: "s@x.com", trigger: "SPONSORSHIP_LINKED" });
    expect(
      await uniqueViolation(insertLog({ registrationId: null, recipientEmail: "s@x.com", trigger: "SPONSORSHIP_LINKED" })),
    ).toBe(RECIPIENT_INDEX);
  });

  it("deletes a registration's email logs with the registration", async () => {
    await scratch.client.query(`DELETE FROM registrations WHERE id = 'reg-new'`);
    expect(await logCount("reg-new")).toBe(0);
    // The log orphaned before 0044 is not touched.
    expect(await logCount(null)).toBe(1);
  });

  it("ends in the same state when its statements run again (crash recovery)", async () => {
    const source = await readFile(
      resolve(__dirname, "../../migrations/0044_email_logs_registration_delete.sql"),
      "utf8",
    );
    for (const statement of splitMigrationStatements(source)) {
      await scratch.client.query(statement);
    }
    await expectMigratedSchema();
  });
});
