import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScratchDatabase } from "@app/db/testing";
import { createScratchDatabase } from "@app/db/testing";
import { applyMigrationsForEngine } from "../../src/migrator";
import { splitMigrationStatements } from "../../src/migrator/migration";
import { dbTestsEnabled } from "../helpers/test-env";
import { dbTestSetupTimeoutMs } from "../../vitest.shared";

// 0030 (2.7): registrations' signup codes are normalized (trim, upper-case,
// blank -> NULL) and a partial unique index allows one registration per
// (event, code). While normalized duplicates exist (claims made before 2.7)
// the migration is deferred rather than failing; it is applied with
// --apply-deferred once the duplicates are resolved.
const INDEX = "registrations_event_id_sponsorship_code_key";

describe.runIf(dbTestsEnabled())("migration tier: registration sponsorship code unique index (0030)", () => {
  let scratch: ScratchDatabase;
  let seq = 0;

  function insertRegistration(values: { eventId?: string; code: string | null }) {
    seq += 1;
    return scratch.client.query(
      `INSERT INTO registrations (id, form_id, event_id, form_data, email, total_amount, price_breakdown, sponsorship_code, updated_at)
       VALUES ($1, 'form-1', $2, '{}'::jsonb, $3, 0, '{}'::jsonb, $4, now())`,
      [`reg-${seq}`, values.eventId ?? "evt-1", `r${seq}@x.com`, values.code],
    );
  }

  async function codes(): Promise<Record<string, string | null>> {
    const { rows } = await scratch.client.query<{ id: string; sponsorship_code: string | null }>(
      "SELECT id, sponsorship_code FROM registrations ORDER BY id",
    );
    return Object.fromEntries(rows.map((row) => [row.id, row.sponsorship_code]));
  }

  async function indexDefinition(): Promise<string | undefined> {
    const { rows } = await scratch.client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_catalog.pg_indexes
       WHERE schemaname = 'public' AND tablename = 'registrations' AND indexname = $1`,
      [INDEX],
    );
    return rows[0]?.indexdef;
  }

  async function uniqueViolation(promise: Promise<unknown>): Promise<string | undefined> {
    const error = await promise.then(
      () => undefined,
      (err: unknown) => err as { code?: string; constraint?: string },
    );
    expect(error?.code).toBe("23505");
    return error?.constraint;
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase({ label: "sponsorship_code_idx", to: "0029" });
    await scratch.client.query(`
      INSERT INTO clients (id, name, updated_at) VALUES ('cli-1', 'Client', now());
      INSERT INTO events (id, client_id, name, slug, start_date, end_date, updated_at)
      VALUES ('evt-1', 'cli-1', 'Event', 'event', now(), now(), now()),
             ('evt-2', 'cli-1', 'Other', 'other', now(), now(), now());
      INSERT INTO forms (id, event_id, name, schema, updated_at)
      VALUES ('form-1', 'evt-1', 'Form', '{}'::jsonb, now());
    `);
    await insertRegistration({ code: " sp-aaaa2222 " }); // reg-1
    await insertRegistration({ code: "SP-BBBB3333" }); // reg-2
    await insertRegistration({ code: "   " }); // reg-3
    await insertRegistration({ code: "sp-bbbb3333" }); // reg-4: the same code as reg-2 once normalized
    await insertRegistration({ code: null }); // reg-5
    await insertRegistration({ eventId: "evt-2", code: "SP-AAAA2222" }); // reg-6: same code, other event
  }, dbTestSetupTimeoutMs());
  afterAll(async () => scratch?.close());

  it("is deferred, changing nothing, while a normalized code is stored twice in an event", async () => {
    const result = await scratch.applyMigrations({ to: "0030" });
    expect(result.deferred).toEqual(["0030"]);
    expect(result.applied).toEqual([]);
    expect(await indexDefinition()).toBeUndefined();
    expect((await codes())["reg-1"]).toBe(" sp-aaaa2222 ");
  });

  it("applies with --apply-deferred once the duplicate is resolved: codes normalized, index built", async () => {
    await scratch.client.query("UPDATE registrations SET sponsorship_code = NULL WHERE id = 'reg-4'");
    const result = await applyMigrationsForEngine(scratch.client, scratch.engine, {
      through: "0030",
      applyDeferred: "0030",
      leaseConnectionString: scratch.url,
      appliedBy: "db-test-helper",
    });
    expect(result.applied).toEqual(["0030"]);

    expect(await codes()).toEqual({
      "reg-1": "SP-AAAA2222",
      "reg-2": "SP-BBBB3333",
      "reg-3": null,
      "reg-4": null,
      "reg-5": null,
      "reg-6": "SP-AAAA2222",
    });
    const definition = await indexDefinition();
    expect(definition).toMatch(/UNIQUE/i);
    expect(definition).toMatch(/event_id/);
    expect(definition).toMatch(/sponsorship_code IS NOT NULL/i);
  });

  it("refuses a second registration with a code in the same event, not elsewhere or without a code", async () => {
    expect(await uniqueViolation(insertRegistration({ code: "SP-AAAA2222" }))).toBe(INDEX);
    await insertRegistration({ eventId: "evt-2", code: "SP-BBBB3333" });
    await insertRegistration({ code: null });
    await insertRegistration({ code: null });
  });

  it("ends in the same state when its statements run again (crash recovery)", async () => {
    const before = await codes();
    const source = await readFile(
      resolve(__dirname, "../../migrations/0030_registration_sponsorship_code_unique.sql"),
      "utf8",
    );
    for (const statement of splitMigrationStatements(source)) {
      await scratch.client.query(statement);
    }
    expect(await codes()).toEqual(before);
    expect(await indexDefinition()).toMatch(/UNIQUE/i);
  });
});
