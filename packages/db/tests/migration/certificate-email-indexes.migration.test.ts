import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScratchDatabase } from "@app/db/testing";
import { createScratchDatabase } from "@app/db/testing";
import { splitMigrationStatements } from "../../src/migrator/migration";
import { dbTestsEnabled } from "../helpers/test-env";
import { dbTestSetupTimeoutMs } from "../../vitest.shared";

// 0024 (2.12): the two per-trigger dedupe indexes from 0001 are rebuilt without
// CERTIFICATE_SENT, keeping their names, so certificate emails dedupe per
// certificate template (in queueCertificateEmailLogsTxn) instead of per
// registration or recipient.
const INDEXES = [
  "email_logs_registration_trigger_active_key",
  "email_logs_template_recipient_trigger_active_key",
];

describe.runIf(dbTestsEnabled())("migration tier: certificate email dedupe indexes (0024)", () => {
  let scratch: ScratchDatabase;
  let seq = 0;

  function insertLog(values: {
    trigger: string;
    registrationId?: string | null;
    recipientEmail?: string;
    status?: string;
    onConflictDoNothing?: boolean;
  }) {
    seq += 1;
    return scratch.client.query<{ id: string }>(
      `INSERT INTO email_logs
         (id, trigger, template_id, registration_id, recipient_email, subject, status, updated_at)
       VALUES ($1, $2, 'tpl-1', $3, $4, '', $5, now())
       ${values.onConflictDoNothing ? "ON CONFLICT DO NOTHING" : ""}
       RETURNING id`,
      [
        `log-${seq}`,
        values.trigger,
        values.registrationId === undefined ? "reg-1" : values.registrationId,
        values.recipientEmail ?? "a@x.com",
        values.status ?? "QUEUED",
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

  async function indexDefinitions(): Promise<Map<string, string>> {
    const { rows } = await scratch.client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_catalog.pg_indexes
       WHERE schemaname = 'public' AND tablename = 'email_logs'`,
    );
    return new Map(rows.map((row) => [row.indexname, row.indexdef]));
  }

  async function expectRebuiltIndexes() {
    const definitions = await indexDefinitions();
    for (const name of INDEXES) {
      expect(definitions.get(name)).toMatch(/UNIQUE/i);
      expect(definitions.get(name)).toContain("CERTIFICATE_SENT");
      expect(definitions.get(name)).toContain("QUEUED");
      expect(definitions.has(`${name}_rebuild`)).toBe(false);
    }
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase({ label: "certificate_email_idx", to: "0023" });
    await scratch.client.query(`
      INSERT INTO clients (id, name, updated_at) VALUES ('cli-1', 'Client', now());
      INSERT INTO events (id, client_id, name, slug, start_date, end_date, updated_at)
      VALUES ('evt-1', 'cli-1', 'Event', 'event', now(), now(), now());
      INSERT INTO forms (id, event_id, name, schema, updated_at)
      VALUES ('form-1', 'evt-1', 'Form', '{}'::jsonb, now());
      INSERT INTO registrations (id, form_id, event_id, form_data, email, total_amount, price_breakdown, updated_at)
      VALUES ('reg-1', 'form-1', 'evt-1', '{}'::jsonb, 'a@x.com', 0, '{}'::jsonb, now());
      INSERT INTO email_templates (id, client_id, event_id, name, subject, content, category, trigger, updated_at)
      VALUES ('tpl-1', 'cli-1', 'evt-1', 'Certificate', 'S', '{}'::jsonb, 'AUTOMATIC', 'CERTIFICATE_SENT', now());
    `);
  }, dbTestSetupTimeoutMs());
  afterAll(async () => scratch?.close());

  it("before 0024, a second active certificate email for a registration is refused", async () => {
    await insertLog({ trigger: "CERTIFICATE_SENT", status: "SENT" });
    // Both indexes cover this row; either may be reported first.
    expect(INDEXES).toContain(await uniqueViolation(insertLog({ trigger: "CERTIFICATE_SENT" })));
  });

  it("rebuilds both indexes under their names without CERTIFICATE_SENT", async () => {
    const result = await scratch.applyMigrations({ to: "0024" });
    expect(result.applied).toEqual(["0024"]);
    await expectRebuiltIndexes();
  });

  it("lets one registration and one recipient hold several active certificate emails", async () => {
    await insertLog({ trigger: "CERTIFICATE_SENT" });
    await insertLog({ trigger: "CERTIFICATE_SENT", registrationId: null });
    await insertLog({ trigger: "CERTIFICATE_SENT", registrationId: null });
    const { rows } = await scratch.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM email_logs
       WHERE trigger = 'CERTIFICATE_SENT' AND recipient_email = 'a@x.com'
         AND status IN ('QUEUED', 'SENT')`,
    );
    expect(Number(rows[0].n)).toBe(4);
  });

  it("still refuses duplicate active emails for other triggers, under the same index names", async () => {
    // Different recipients, so only the registration + trigger index applies.
    await insertLog({ trigger: "REGISTRATION_CREATED", recipientEmail: "r1@x.com" });
    expect(
      await uniqueViolation(insertLog({ trigger: "REGISTRATION_CREATED", recipientEmail: "r2@x.com" })),
    ).toBe(INDEXES[0]);

    // No registration, so only the template + recipient + trigger index applies.

    await insertLog({ trigger: "SPONSORSHIP_LINKED", registrationId: null, recipientEmail: "s@x.com" });
    expect(
      await uniqueViolation(
        insertLog({ trigger: "SPONSORSHIP_LINKED", registrationId: null, recipientEmail: "s@x.com" }),
      ),
    ).toBe(INDEXES[1]);
  });

  it("skips a row a partial index refuses with a target-less ON CONFLICT DO NOTHING", async () => {
    const refused = await insertLog({
      trigger: "REGISTRATION_CREATED",
      recipientEmail: "r3@x.com",
      onConflictDoNothing: true,
    });
    expect(refused.rows).toEqual([]);
    const kept = await insertLog({ trigger: "CERTIFICATE_SENT", onConflictDoNothing: true });
    expect(kept.rows).toHaveLength(1);
  });

  it("ends in the same state when its statements run again (crash recovery)", async () => {
    const source = await readFile(
      resolve(__dirname, "../../migrations/0024_certificate_email_dedupe_indexes.sql"),
      "utf8",
    );
    for (const statement of splitMigrationStatements(source)) {
      await scratch.client.query(statement);
    }
    await expectRebuiltIndexes();
    expect(
      await uniqueViolation(insertLog({ trigger: "REGISTRATION_CREATED", recipientEmail: "r4@x.com" })),
    ).toBe(INDEXES[0]);
    await insertLog({ trigger: "CERTIFICATE_SENT" });
  });
});
