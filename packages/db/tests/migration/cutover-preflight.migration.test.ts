import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ScratchDatabase } from "@app/db/testing";
import { createScratchDatabase, dbTestsEnabled } from "@app/db/testing";
import { defaultMigrationsDirectory } from "../../src/migrator";
import {
  collectTableCounts,
  compareTableCounts,
  parseTableCountsFile,
  runCutoverPreflight,
  writeCutoverPreflight,
  type AffectedRowsFile,
  type CutoverPreflightReport,
  type CutoverPreflightResult,
  type DataCheckEntry,
} from "../../src/ops/cutover-preflight";
import { migrationWillRun } from "../../src/ops/cutover-preflight-report";
import { dbTestSetupTimeoutMs } from "../../../vitest.shared";

// The cutover preflight on databases built by the runner through 0003 (before
// every data-changing migration) and seeded with rows each check must catch:
// (A) without a ledger, like production before `adopt`; (B) with its ledger,
// then migrated, to prove the exports predicted exactly what apply changed and
// that postflight accepts the 0033 drop but not a deleted row.

const SEED = `
INSERT INTO clients (id, name, updated_at) VALUES ('cl1', 'Client', now());
INSERT INTO events (id, client_id, name, slug, start_date, end_date, updated_at) VALUES
  ('ev1', 'cl1', 'Event', 'event', now(), now(), now()),
  ('ev2', 'cl1', 'Other', 'other', now(), now(), now());
INSERT INTO forms (id, event_id, name, schema, updated_at) VALUES ('form-1', 'ev1', 'Form', '{}'::jsonb, now());
INSERT INTO event_access (id, event_id, name, updated_at) VALUES ('acc-1', 'ev1', 'Workshop', now());
-- 0004: two active jobs for ev1 (the index cannot be built), one for ev2.
INSERT INTO abstract_book_jobs (id, event_id, requested_by, status, created_at, updated_at) VALUES
  ('job-1', 'ev1', 'admin', 'PENDING', '2026-05-01 10:00:00', now()),
  ('job-2', 'ev1', 'admin', 'RUNNING', '2026-05-01 10:01:00', now()),
  ('job-3', 'ev2', 'admin', 'PENDING', '2026-05-01 10:02:00', now()),
  ('job-4', 'ev1', 'admin', 'COMPLETED', '2026-04-01 10:00:00', now());
-- 0006: t-coded keeps slot 2 (issued codes), t-loser moves to max(5) + 1.
INSERT INTO abstract_config (id, event_id, updated_at) VALUES ('cfg1', 'ev1', now());
INSERT INTO abstract_themes (id, config_id, label, sort_order, active, created_at, updated_at) VALUES
  ('t-coded', 'cfg1', 'Coded', 2, true, '2026-02-01', now()),
  ('t-loser', 'cfg1', 'Loser', 2, true, '2026-01-01', '2026-01-02 03:04:05.678'),
  ('t-inactive', 'cfg1', 'Inactive', 2, false, '2026-01-01', now()),
  ('t-max', 'cfg1', 'Max', 5, true, '2026-01-01', now());
INSERT INTO abstract_code_counters (id, event_id, theme_id, final_type, last_value, updated_at)
  VALUES ('cnt1', 'ev1', 't-coded', 'ORAL_COMMUNICATION', 7, now());
-- 0011 (reg-net stores the net total), 0030 (codes), origins, sponsored VERIFYING.
INSERT INTO registrations (id, form_id, event_id, form_data, email, payment_status, total_amount, sponsorship_amount,
                           price_breakdown, sponsorship_code, link_base_url, created_at, updated_at) VALUES
  ('reg-net', 'form-1', 'ev1', '{}'::jsonb, 'net@x.test', 'VERIFYING', 40, 60, '{"subtotal": 100, "total": 40}'::jsonb,
   ' sp-aaaa ', 'https://forms.example.org/r/abc', '2026-05-02 10:00:00', '2026-05-02 10:00:00.123'),
  ('reg-gross', 'form-1', 'ev1', '{}'::jsonb, 'gross@x.test', 'PENDING', 100, 60, '{"subtotal": 100, "total": 40}'::jsonb,
   'SP-AAAA', 'HTTPS://Forms.Example.org/x', '2026-05-03 10:00:00', now()),
  ('reg-blank', 'form-1', 'ev1', '{}'::jsonb, 'blank@x.test', 'PENDING', 80, 0, '{"subtotal": 80, "total": 80}'::jsonb,
   '   ', 'not a url', '2026-05-01 10:00:00', now()),
  ('reg-clean', 'form-1', 'ev2', '{}'::jsonb, 'clean@x.test', 'PAID', 80, 0, '{"subtotal": 80, "total": 80}'::jsonb,
   'SP-BBBB', NULL, '2026-05-01 10:00:00', now());
INSERT INTO sponsorship_batches (id, event_id, form_id, lab_name, contact_name, email, form_data)
  VALUES ('sb1', 'ev1', 'form-1', 'Lab', 'Contact', 'lab@x.test', '{}'::jsonb);
INSERT INTO sponsorships (id, batch_id, event_id, code, beneficiary_name, beneficiary_email, covered_access_ids, total_amount, updated_at)
  VALUES ('sp1', 'sb1', 'ev1', 'SP-AAAA', 'Net', 'net@x.test', ARRAY['acc-1'], 60, now());
INSERT INTO sponsorship_usages (id, sponsorship_id, registration_id, amount_applied, applied_by)
  VALUES ('su1', 'sp1', 'reg-net', 60, 'admin');
INSERT INTO abstracts (id, event_id, author_first_name, author_last_name, author_email, author_phone, requested_type,
                       content, edit_token, link_base_url, updated_at)
  VALUES ('abs-1', 'ev1', 'Ada', 'L', 'ada@x.test', '1', 'POSTER', '{}'::jsonb, 'tok', 'https://abstracts.example.org/s/1', now());
-- 0033: the legacy counter table is dropped with its rows.
INSERT INTO abstract_code_sequences (id, final_type, last_value, updated_at) VALUES
  ('seq-oc', 'ORAL_COMMUNICATION', 12, '2026-03-01 08:00:00'),
  ('seq-p', 'POSTER', 4, '2026-03-01 08:00:00');
INSERT INTO email_logs (id, recipient_email, subject, status, updated_at) VALUES
  ('mail-q', 'a@x.test', 'S', 'QUEUED', now()),
  ('mail-s', 'b@x.test', 'S', 'SENDING', now()),
  ('mail-sent-1', 'c@x.test', 'S', 'SENT', now()),
  ('mail-sent-2', 'd@x.test', 'S', 'SENT', now());
INSERT INTO outbox_events (id, type, payload, status, updated_at) VALUES
  ('ob-1', 'email.queued', '{}'::jsonb, 'PENDING', now()),
  ('ob-2', 'email.queued', '{}'::jsonb, 'PROCESSING', now());
`;

// Production's check-in columns are timestamptz(6) (main prisma/schema.prisma
// :267, :508); fresh Nest databases start at timestamp(3) until 0010.
async function productionCheckInColumns(client: Client): Promise<void> {
  await client.query("ALTER TABLE registrations ALTER COLUMN checked_in_at TYPE timestamptz(6)");
  await client.query("ALTER TABLE access_check_ins ALTER COLUMN checked_in_at TYPE timestamptz(6)");
  await client.query(`UPDATE registrations SET checked_in_at = '2026-05-04 09:00:00.123456+00' WHERE id = 'reg-net'`);
  await client.query(`UPDATE registrations SET checked_in_at = '2026-05-04 09:00:00.123+00' WHERE id = 'reg-gross'`);
  await client.query(`INSERT INTO access_check_ins (id, registration_id, access_id, checked_in_at, checked_in_by)
    VALUES ('ci-1', 'reg-net', 'acc-1', '2026-05-04 09:30:00.987654+00', 'staff')`);
}

const LEDGER_TABLES = ["schema_migration_steps", "schema_migrations", "schema_migration_lock"];

/** Statements the preflight's own connection sent (the scratch client is excluded). */
function recordPreflightStatements(scratch: Client): { statements: string[]; restore(): void } {
  const statements: string[] = [];
  const original = Client.prototype.query;
  const spy = vi.spyOn(Client.prototype, "query").mockImplementation(function (this: Client, ...args: unknown[]) {
    if (this !== scratch && typeof args[0] === "string") statements.push(args[0].trim());
    return (original as (...values: unknown[]) => unknown).apply(this, args) as never;
  });
  return { statements, restore: () => spy.mockRestore() };
}

function check(report: CutoverPreflightReport, id: string): DataCheckEntry {
  const entry = report.dataChecks.find((candidate) => candidate.migrationId === id);
  if (!entry) throw new Error(`no data check for ${id}`);
  return entry;
}

function exported(result: CutoverPreflightResult, id: string): AffectedRowsFile {
  const file = result.affected.find((candidate) => candidate.migrationId === id);
  if (!file) throw new Error(`no export for ${id}`);
  return file;
}

/** Values the preflight must leave untouched (it reads them all). */
async function snapshot(client: Client): Promise<unknown[]> {
  const queries = [
    "SELECT id, status::text FROM abstract_book_jobs ORDER BY id",
    "SELECT id, sort_order, updated_at::text FROM abstract_themes ORDER BY id",
    "SELECT id, total_amount, sponsorship_code, checked_in_at::text, updated_at::text FROM registrations ORDER BY id",
    "SELECT id, last_value FROM abstract_code_sequences ORDER BY id",
    "SELECT id, checked_in_at::text FROM access_check_ins ORDER BY id",
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  ];
  const results = [];
  for (const sql of queries) results.push((await client.query(sql)).rows);
  return results;
}

describe.runIf(dbTestsEnabled())("cutover preflight and postflight", () => {
  const databases: ScratchDatabase[] = [];
  let outRoot: string;

  async function seeded(label: string): Promise<ScratchDatabase> {
    const database = await createScratchDatabase({ label, to: "0003" });
    databases.push(database);
    await database.client.query(SEED);
    await productionCheckInColumns(database.client);
    return database;
  }

  async function preflight(database: ScratchDatabase, name: string) {
    const recorder = recordPreflightStatements(database.client);
    let result: CutoverPreflightResult;
    try {
      result = await runCutoverPreflight({ connectionString: database.url, migrationsDirectory: defaultMigrationsDirectory() });
    } finally {
      recorder.restore();
    }
    const directory = join(outRoot, name);
    await writeCutoverPreflight(directory, result);
    return { result, statements: recorder.statements, directory };
  }

  beforeAll(async () => {
    outRoot = await mkdtemp(join(tmpdir(), "cutover-preflight-"));
  });

  afterAll(async () => {
    for (const database of databases) await database.close().catch(() => undefined);
    await rm(outRoot, { recursive: true, force: true });
  }, dbTestSetupTimeoutMs());

  describe("legacy database without a ledger", () => {
    let database: ScratchDatabase;
    let run: Awaited<ReturnType<typeof preflight>>;
    let before: unknown[];

    beforeAll(async () => {
      database = await seeded("preflight_legacy");
      for (const table of LEDGER_TABLES) await database.client.query(`DROP TABLE public.${table}`);
      before = await snapshot(database.client);
      run = await preflight(database, "legacy");
    }, dbTestSetupTimeoutMs());

    it("runs every query in one read-only transaction that refuses a write and is rolled back", async () => {
      const { statements } = run;
      expect(statements[0]).toBe("SET default_transaction_read_only = on");
      expect(statements[2]).toMatch(/^BEGIN TRANSACTION ISOLATION LEVEL [A-Z ]+, (PRIORITY LOW, )?READ ONLY$/);
      expect(statements.at(-1)).toBe("ROLLBACK");
      expect(statements).not.toContain("COMMIT");
      const probe = run.result.report.session.writeProbe;
      expect(probe).toEqual({ table: "_AccessPrerequisites", sqlstate: "25006" });
      const writes = statements.filter((sql) => /^(INSERT|UPDATE|UPSERT|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT)\b/i.test(sql));
      expect(writes).toEqual(['DELETE FROM public."_AccessPrerequisites" WHERE false']);
      expect(run.result.report.session.readOnly).toBe(true);
      expect(await snapshot(database.client)).toEqual(before);
    });

    it("includes the adopt dry run and writes no ledger", async () => {
      const { report } = run.result;
      expect(report.ledger.present).toBe(false);
      expect(report.adopt.ran).toBe(true);
      expect(report.adopt.lines?.[0]).toMatch(/^Migration adoption \((postgres|cockroach); dry run \(no changes\)\):$/);
      const verdicts = Object.fromEntries((report.adopt.verdicts ?? []).map((entry) => [entry.id, entry.verdict]));
      for (const id of ["0004", "0006", "0011", "0030"]) expect(verdicts[id]).toBe("pending");
      expect(verdicts["0010"]).toBe("applied");
      const ledger = await database.client.query("SELECT to_regclass('public.schema_migrations') IS NULL AS absent");
      expect(ledger.rows[0]?.absent).toBe(true);
    });

    it("exports the rows each data-changing migration touches, with their current values", async () => {
      const { report } = run.result;
      expect(check(report, "0004")).toMatchObject({ status: "fails", affectedRows: 2, export: "affected/0004.json" });
      expect(exported(run.result, "0004").rows.map((row) => row.id)).toEqual(["job-1", "job-2"]);

      expect(check(report, "0006")).toMatchObject({ status: "changes-rows", affectedRows: 1, review: true });
      expect(exported(run.result, "0006").rows).toEqual([
        expect.objectContaining({ id: "t-loser", sort_order: 2, new_sort_order: 6, issued_codes: 0, slot_kept_by: "t-coded", updated_at: "2026-01-02 03:04:05.678" }),
      ]);

      // Adopt accepts production's timestamptz(6) columns as 0010, so apply
      // never rewrites them and no check-in value loses its microseconds.
      expect(check(report, "0010")).toMatchObject({ status: "skipped", adopt: "applied", affectedRows: 0 });
      expect(check(report, "0010").export).toBeUndefined();

      expect(check(report, "0011")).toMatchObject({ status: "changes-rows", affectedRows: 1, review: true });
      expect(exported(run.result, "0011").rows).toEqual([expect.objectContaining({
        id: "reg-net", payment_status: "VERIFYING", total_amount: 40, sponsorship_amount: 60,
        price_breakdown_subtotal: 100, price_breakdown_total: 40, new_total_amount: 100, updated_at: "2026-05-02 10:00:00.123",
      })]);

      expect(check(report, "0030")).toMatchObject({ status: "deferred", affectedRows: 2, details: { duplicatePairs: 1, deferUnless: false } });
      const codes = exported(run.result, "0030");
      expect(codes.rows.map((row) => [row.id, row.sponsorship_code, row.new_sponsorship_code]))
        .toEqual([["reg-blank", "   ", null], ["reg-net", " sp-aaaa ", "SP-AAAA"]]);
      expect(codes.related?.duplicates?.map((row) => row.id)).toEqual(["reg-net", "reg-gross"]);

      expect(check(report, "0033")).toMatchObject({ status: "changes-rows", affectedRows: 2 });
      expect(exported(run.result, "0033").rows).toEqual([
        expect.objectContaining({ id: "seq-oc", final_type: "ORAL_COMMUNICATION", last_value: 12 }),
        expect.objectContaining({ id: "seq-p", final_type: "POSTER", last_value: 4 }),
      ]);
    });

    it("reports queues, email statuses, link origins, sponsored VERIFYING rows and counts", async () => {
      const { report, tableCounts } = run.result;
      expect(report.queues).toEqual([
        { table: "email_logs", counts: { QUEUED: 1, SENDING: 1 }, inFlight: 1 },
        { table: "outbox_events", counts: { PENDING: 1, PROCESSING: 1, FAILED: 0 }, inFlight: 1 },
        { table: "abstract_book_jobs", counts: { PENDING: 2, RUNNING: 1 }, inFlight: 1 },
      ]);
      expect(report.emailStatusCounts).toEqual({ QUEUED: 1, SENDING: 1, SENT: 2 });
      expect(report.linkOrigins.registrations?.map((entry) => [entry.origin, entry.count])).toEqual([
        ["https://forms.example.org", 2],
        [null, 1],
      ]);
      expect(report.linkOrigins.abstracts?.map((entry) => entry.origin)).toEqual(["https://abstracts.example.org"]);
      expect(report.sponsoredVerifying).toEqual({ count: 1, registrationIds: ["reg-net"] });
      expect(tableCounts.tables).toMatchObject({ registrations: 4, abstract_book_jobs: 4, abstract_code_sequences: 2, email_logs: 4 });
      expect(Object.keys(tableCounts.tables).length).toBe(report.tableCounts.tables);
      expect(report.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ level: "blocker", topic: "0004 0004_abstract_book_jobs_active_unique.sql" }),
      ]));
      expect(report.foreignKeys?.byMigration.find((entry) => entry.migrationId === "0000"))
        .toMatchObject({ declared: 43, byDeclaredName: 43, missing: [] });
    });

    it("writes the report, the counts and one export per checked migration, marked as personal data", async () => {
      const { directory } = run;
      expect((await readdir(directory)).sort()).toEqual(["affected", "report.json", "report.md", "table-counts.json"]);
      expect((await readdir(join(directory, "affected"))).sort())
        .toEqual(["0004.json", "0006.json", "0011.json", "0030.json", "0033.json"]);
      const markdown = await readFile(join(directory, "report.md"), "utf8");
      expect(markdown).toContain("**Personal data.**");
      expect(markdown).not.toContain(database.url);
      const json = await readFile(join(directory, "report.json"), "utf8");
      expect(json).not.toContain(new URL(database.url).host);
      expect(JSON.parse(await readFile(join(directory, "affected", "0011.json"), "utf8"))).toMatchObject({ notice: expect.stringContaining("personal data") });
      await expect(writeCutoverPreflight(directory, run.result)).rejects.toThrow("not empty");
    });
  });

  describe("legacy database whose adopt --apply stopped after creating the ledger", () => {
    let database: ScratchDatabase;
    let result: CutoverPreflightResult;

    beforeAll(async () => {
      database = await seeded("preflight_empty_ledger");
      // adopt creates the ledger tables before it takes the lease; a failure
      // after that leaves them empty, and adopt and apply still treat the
      // database as not adopted.
      for (const table of LEDGER_TABLES) await database.client.query(`DELETE FROM public.${table}`);
      ({ result } = await preflight(database, "empty-ledger"));
    }, dbTestSetupTimeoutMs());

    it("reads an empty ledger as no ledger, like adopt and apply", () => {
      const { report } = result;
      expect(report.ledger).toMatchObject({ present: true, records: [] });
      expect(report.adopt.ran).toBe(true);
      expect(report.migrations.find((migration) => migration.id === "0010")).toMatchObject({ ledger: "no-ledger", adopt: "applied" });
      expect(migrationWillRun(report, "0010")).toBe(false);
      expect(migrationWillRun(report, "0011")).toBe(true);
      expect(check(report, "0010")).toMatchObject({ status: "skipped", ledger: "no-ledger", adopt: "applied", affectedRows: 0 });
      expect(check(report, "0010").export).toBeUndefined();
      expect(check(report, "0011")).toMatchObject({ status: "changes-rows", affectedRows: 1 });
      expect(result.affected.map((file) => file.migrationId)).not.toContain("0010");
    });
  });

  describe("database with a ledger, migrated, then checked by postflight", () => {
    let database: ScratchDatabase;
    let run: Awaited<ReturnType<typeof preflight>>;

    beforeAll(async () => {
      database = await seeded("preflight_ledger");
      run = await preflight(database, "ledger");
    }, dbTestSetupTimeoutMs());

    it("skips adopt and checks only what the ledger has not applied", () => {
      const { report } = run.result;
      expect(report.ledger).toMatchObject({ present: true, unknown: [] });
      expect(report.ledger.records.map((record) => record.id)).toEqual(["0000", "0001", "0002", "0003"]);
      expect(report.adopt).toMatchObject({ ran: false });
      expect(report.dataChecks.map((entry) => entry.status)).toEqual(["fails", "changes-rows", "changes-rows", "changes-rows", "deferred", "changes-rows"]);
    });

    it("predicted exactly what apply changes, and postflight accepts the 0033 drop", async () => {
      // Operator step for the 0004 blocker: settle the stale job first.
      await database.client.query("UPDATE abstract_book_jobs SET status = 'FAILED' WHERE id = 'job-2'");
      const result = await database.applyMigrations();
      expect(result.deferred).toEqual(["0030"]);

      const themes = await database.client.query<{ sort_order: number }>("SELECT sort_order FROM abstract_themes WHERE id = 't-loser'");
      expect(Number(themes.rows[0]?.sort_order)).toBe(exported(run.result, "0006").rows[0]?.new_sort_order);
      const registrations = await database.client.query<{ id: string; total_amount: number; sponsorship_code: string | null; checked_in_at: string | null }>(
        "SELECT id, total_amount, sponsorship_code, checked_in_at::text AS checked_in_at FROM registrations ORDER BY id",
      );
      const byId = new Map(registrations.rows.map((row) => [row.id, row]));
      for (const row of exported(run.result, "0011").rows) expect(Number(byId.get(String(row.id))?.total_amount)).toBe(row.new_total_amount);
      expect(Number(byId.get("reg-gross")?.total_amount)).toBe(100);
      const rounded = exported(run.result, "0010").rows.find((row) => row.id === "reg-net");
      expect(byId.get("reg-net")?.checked_in_at).toBe(rounded?.new_checked_in_at);
      expect(byId.get("reg-net")?.sponsorship_code).toBe(" sp-aaaa "); // deferred: not normalized yet

      const baseline = parseTableCountsFile(await readFile(join(run.directory, "table-counts.json"), "utf8"));
      const comparison = compareTableCounts(baseline, await collectTableCounts(database.url));
      expect(comparison).toMatchObject({ ok: true, lost: [], vanished: [], uncounted: [] });
      expect(comparison.exempt.map((entry) => entry.table)).toEqual(["abstract_code_sequences"]);
      expect(comparison.added.map((entry) => entry.table)).toEqual(expect.arrayContaining(["worker_heartbeats", "registration_reference_counters"]));
    });

    it("on the migrated database skips applied migrations but still counts every table", async () => {
      const again = await preflight(database, "migrated");
      const statuses = Object.fromEntries(again.result.report.dataChecks.map((entry) => [entry.migrationId, entry.status]));
      expect(statuses).toEqual({ "0004": "skipped", "0006": "skipped", "0010": "skipped", "0011": "skipped", "0030": "deferred", "0033": "skipped" });
      expect(again.result.affected.map((file) => file.migrationId)).toEqual(["0030"]);
      expect(again.result.tableCounts.tables.abstract_code_sequences).toBeUndefined();
      expect(again.result.tableCounts.tables.registrations).toBe(4);
    });

    it("postflight fails when a table lost a row", async () => {
      await database.client.query("DELETE FROM email_logs WHERE id = 'mail-sent-2'");
      const baseline = parseTableCountsFile(await readFile(join(run.directory, "table-counts.json"), "utf8"));
      const comparison = compareTableCounts(baseline, await collectTableCounts(database.url));
      expect(comparison.ok).toBe(false);
      expect(comparison.lost).toEqual([{ table: "email_logs", before: 4, after: 3 }]);
    });
  });
});
