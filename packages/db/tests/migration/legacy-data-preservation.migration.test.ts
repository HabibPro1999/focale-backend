import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { checkStoredJson } from "@app/contracts";
import { calculateSettlement, normalizeSponsorshipCode } from "@app/shared";
import {
  abstractBookQueue,
  allocateReferenceNumber,
  applyPaidRepairRow,
  applySponsorshipCodeLink,
  checkSettlementInvariants,
  clearRegistrationSponsorshipCode,
  closeDb,
  configureJsonbValidation,
  emailQueue,
  finalizeAbstractTxn,
  findRegistrationFormByEventSlug,
  findSponsorFormByEventSlug,
  getCertificateTemplateWithEvent,
  getClaimedEmailLogsForProcessing,
  getDb,
  getRegistrationByIdRow,
  listAdminAbstracts,
  listCertificateTemplates,
  listRegistrationRows,
  outboxQueue,
  planPaidSettlementRepair,
  planSponsorshipCodeRepair,
  readEmailContextSnapshot,
  readStoredJsonbPage,
  settleRegistrationTxn,
  STORED_JSONB_COLUMNS,
  withLockingTxn,
  type SettlementInvariantReport,
} from "@app/db";
import type { ScratchDatabase } from "@app/db/testing";
import { dbTestsEnabled } from "@app/db/testing";
import {
  adoptMigrations,
  applyMigrations,
  defaultMigrationsDirectory,
  listMigrationRecords,
  loadMigrations,
  migrationAdoptionSupport,
  verifyMigrations,
  type MigrationDefinition,
} from "../../src/migrator";
import { dbTestSetupTimeoutMs } from "../../../vitest.shared";
import { LEGACY_IDS, seedLegacyData, type LegacySeedOptions } from "../helpers/legacy-data";
import { createLegacyPrismaDatabase } from "../helpers/legacy-prisma";

// Production data through the whole cutover. The legacy production schema
// (createLegacyPrismaDatabase) holds rows in every table, written the way
// main's writers write them (helpers/legacy-data.ts). Every row and column is
// read as text before `adopt`, the rollout runs as an operator runs it
// (adopt dry run, adopt --apply, the README's 0011 query, apply, verify
// --schema), and the same read afterwards must show no lost table, column or
// row and no changed value except the transformations listed here. Then the
// Nest read and write paths run on the migrated legacy rows.

const ids = LEGACY_IDS;
const reg = ids.registration;

/** "registration.signupCode" for a seeded id, so a failure names the row. */
const NAMES = new Map<string, string>(
  Object.entries(LEGACY_IDS).flatMap(([kind, group]) =>
    Object.entries(group).map(([name, id]) => [id, `${kind}.${name}`] as [string, string]),
  ),
);
const nameOf = (id: string) => NAMES.get(id) ?? id;
const NAMES_TO_IDS = new Map<string, string>([...NAMES].map(([id, name]) => [name, id]));

// ============================================================================
// Snapshot: every column of every row, as text
// ============================================================================

interface TableSnapshot {
  /** column -> "data_type/udt_name" */
  columns: Record<string, string>;
  /** row key (id, or the whole row for the id-less join table) -> column -> text */
  rows: Map<string, Record<string, string | null>>;
}
type DatabaseSnapshot = Record<string, TableSnapshot>;

async function publicTables(client: Client): Promise<string[]> {
  const result = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  return result.rows.map((row) => row.table_name);
}

async function snapshotTables(client: Client, tables: readonly string[]): Promise<DatabaseSnapshot> {
  const snapshot: DatabaseSnapshot = {};
  for (const table of tables) {
    const columns = await client.query<{ column_name: string; data_type: string; udt_name: string }>(
      `SELECT column_name, data_type, udt_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [table],
    );
    if (columns.rows.length === 0) continue;
    const names = columns.rows.map((row) => row.column_name);
    const result = await client.query<Record<string, string | null>>(
      `SELECT ${names.map((name) => `"${name}"::TEXT AS "${name}"`).join(", ")} FROM public."${table}"`,
    );
    const rows = new Map<string, Record<string, string | null>>();
    for (const row of result.rows) rows.set(row.id ? nameOf(row.id) : JSON.stringify(row), row);
    snapshot[table] = {
      columns: Object.fromEntries(columns.rows.map((row) => [row.column_name, `${row.data_type}/${row.udt_name}`])),
      rows,
    };
  }
  return snapshot;
}

interface CellChange {
  table: string;
  row: string;
  column: string;
  before: string | null;
  after: string | null;
}

/** What `after` lost or changed of `before`; columns `after` added are not compared. */
function diffSnapshots(before: DatabaseSnapshot, after: DatabaseSnapshot) {
  const droppedTables: string[] = [];
  const droppedColumns: string[] = [];
  const retypedColumns: string[] = [];
  const droppedRows: string[] = [];
  const addedRows: string[] = [];
  const changes: CellChange[] = [];
  for (const [table, old] of Object.entries(before)) {
    const now = after[table];
    if (!now) {
      droppedTables.push(table);
      continue;
    }
    for (const [column, type] of Object.entries(old.columns)) {
      if (!(column in now.columns)) droppedColumns.push(`${table}.${column}`);
      else if (now.columns[column] !== type) retypedColumns.push(`${table}.${column}: ${type} -> ${now.columns[column]}`);
    }
    for (const [key, row] of old.rows) {
      const next = now.rows.get(key);
      if (!next) {
        droppedRows.push(`${table} ${key}`);
        continue;
      }
      for (const column of Object.keys(old.columns)) {
        if (column in next && next[column] !== row[column]) {
          changes.push({ table, row: key, column, before: row[column] ?? null, after: next[column] ?? null });
        }
      }
    }
    for (const key of now.rows.keys()) if (!old.rows.has(key)) addedRows.push(`${table} ${key}`);
  }
  changes.sort((a, b) => `${a.table} ${a.row} ${a.column}`.localeCompare(`${b.table} ${b.row} ${b.column}`));
  return { droppedTables, droppedColumns, retypedColumns, droppedRows, addedRows, changes };
}

/** An `updated_at` a migration set to its own clock: later than the seeded value. */
const MIGRATION_TIME = "(migration time)";
function withMigrationTimes(changes: CellChange[]): CellChange[] {
  return changes.map((change) => {
    if (change.column !== "updated_at") return change;
    expect(change.after! > change.before!, `${change.table} ${change.row} updated_at moved forward`).toBe(true);
    return { ...change, after: MIGRATION_TIME };
  });
}

function rowCounts(snapshot: DatabaseSnapshot): Record<string, number> {
  return Object.fromEntries(Object.entries(snapshot).map(([table, { rows }]) => [table, rows.size]));
}

// ============================================================================
// Database plumbing
// ============================================================================

const originalEnv = { DATABASE_URL: process.env.DATABASE_URL };

/** Point @app/db's pool at `database`, as an app process with that DATABASE_URL. */
async function useDatabase(database: ScratchDatabase): Promise<void> {
  await closeDb();
  process.env.DATABASE_URL = database.url;
  if (database.engine === "cockroach") {
    // As tests/setup.db.ts: application sessions use READ COMMITTED on CockroachDB.
    const pool = (getDb() as unknown as {
      $client?: { options?: { onConnect?: (client: { query: (sql: string) => Promise<unknown> }) => Promise<void> } };
    }).$client;
    if (!pool?.options) throw new Error("Cannot configure CockroachDB sessions");
    pool.options.onConnect = async (client) => {
      await client.query("SET default_transaction_isolation = 'read committed'");
    };
  }
}

async function releaseDatabase(): Promise<void> {
  await closeDb();
  if (originalEnv.DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalEnv.DATABASE_URL;
}

async function createSeededLegacyDatabase(label: string, options: LegacySeedOptions = {}): Promise<ScratchDatabase> {
  const database = await createLegacyPrismaDatabase({ label });
  try {
    // The migrator pins its sessions to UTC; the snapshots read timestamptz text in the same zone.
    await database.client.query("SET TIME ZONE 'UTC'");
    await seedLegacyData(database.client, options);
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
  return database;
}

/** The read-only query of the migrator README, rollout step 4, verbatim. */
const README_0011_QUERY = `
   SELECT id, event_id, total_amount, price_breakdown->>'subtotal' AS subtotal
   FROM registrations
   WHERE sponsorship_amount > 0
     AND jsonb_typeof(price_breakdown->'subtotal') = 'number'
     AND jsonb_typeof(price_breakdown->'total') = 'number'
     AND total_amount = (price_breakdown->>'total')::integer
     AND (price_breakdown->>'subtotal')::integer > total_amount;`;

/**
 * The README's 0011 rows whose stored sponsorship is below the breakdown's:
 * an admin linked the signup code and main capped the usage at the net
 * total. After 0011 they owe subtotal − sponsorship, more than the net the
 * breakdown quoted. Only live events (not archived, not ended) are listed:
 * rows of finished events keep 0011's result as they are.
 */
const OVER_QUOTE_0011_QUERY = `
   SELECT r.id, r.event_id, r.total_amount, r.sponsorship_amount, (r.price_breakdown->>'sponsorshipTotal')::integer AS quoted_sponsorship
   FROM registrations r
   JOIN events e ON e.id = r.event_id
   WHERE r.sponsorship_amount > 0
     AND e.status <> 'ARCHIVED'
     AND e.end_date >= now()
     AND jsonb_typeof(r.price_breakdown->'subtotal') = 'number'
     AND jsonb_typeof(r.price_breakdown->'total') = 'number'
     AND jsonb_typeof(r.price_breakdown->'sponsorshipTotal') = 'number'
     AND r.total_amount = (r.price_breakdown->>'total')::integer
     AND (r.price_breakdown->>'subtotal')::integer > r.total_amount
     AND r.sponsorship_amount < (r.price_breakdown->>'sponsorshipTotal')::integer;`;

async function readme0011Rows(client: Client): Promise<{ id: string; total: number; subtotal: number }[]> {
  const result = await client.query<{ id: string; total_amount: number; subtotal: string }>(README_0011_QUERY);
  return result.rows
    .map((row) => ({ id: nameOf(row.id), total: Number(row.total_amount), subtotal: Number(row.subtotal) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

interface MoneyRow {
  id: string;
  status: string;
  total: number;
  sponsorship: number;
  paid: number;
}

async function moneyRows(client: Client): Promise<Map<string, MoneyRow>> {
  const result = await client.query<{
    id: string;
    payment_status: string;
    total_amount: number;
    sponsorship_amount: number;
    paid_amount: number;
  }>("SELECT id, payment_status::TEXT AS payment_status, total_amount, sponsorship_amount, paid_amount FROM registrations");
  return new Map(
    result.rows.map((row) => [
      nameOf(row.id),
      {
        id: row.id,
        status: row.payment_status,
        total: Number(row.total_amount),
        sponsorship: Number(row.sponsorship_amount),
        paid: Number(row.paid_amount),
      },
    ]),
  );
}

/** The offending rows of each invariant check, as "registration.x PROBLEM". */
function problems(report: SettlementInvariantReport): Record<string, string[]> {
  return Object.fromEntries(
    report.checks.map((check) => [
      check.name,
      check.samples.map((sample) => `${nameOf(String(sample.id ?? sample.code))} ${String(sample.problem)}`).sort(),
    ]),
  );
}

async function storedJsonFindings(): Promise<Record<string, { scanned: number; invalid: string[] }>> {
  const report: Record<string, { scanned: number; invalid: string[] }> = {};
  for (const entry of STORED_JSONB_COLUMNS) {
    const rows = await readStoredJsonbPage(entry, undefined, 1000);
    report[entry.name] = {
      scanned: rows.length,
      invalid: rows.flatMap((row) => {
        const issues = checkStoredJson(entry.schema, row.value);
        return issues.length === 0 ? [] : [`${nameOf(row.id)}: ${issues.map((issue) => `${issue.path} ${issue.code}`).join(", ")}`];
      }),
    };
  }
  return report;
}

// ============================================================================
// Expectations
// ============================================================================

/**
 * Legacy's settlement, verbatim from main (0f86c91d,
 * src/shared/utils/settlement.ts), for the amount due legacy showed on a
 * legacy row. Nest's is calculateSettlement in packages/shared.
 */
function legacyCalculateSettlement(reg: {
  totalAmount: number;
  paidAmount: number;
  sponsorshipAmount: number;
}) {
  const covered = reg.paidAmount + reg.sponsorshipAmount;
  const amountDue = Math.max(0, reg.totalAmount - covered);
  return {
    amountDue,
    netAmount: Math.max(0, reg.totalAmount - reg.sponsorshipAmount),
    isSettled: amountDue === 0 && reg.totalAmount >= 0,
    isPartiallyPaid: covered > 0 && amountDue > 0,
  };
}

/**
 * Every registration's money before and after the cutover. Legacy and Nest
 * compute the amount due with the same formula, max(0, total − paid −
 * sponsorship), but legacy stored a net total for a signup code
 * (registrations.service.ts:448) and for an admin edit of a linked
 * registration (registrations.service.ts:1217), so its due subtracted the
 * sponsorship twice. 0011 stores the gross total for those rows.
 *
 * [status, total before, total after, sponsorship, paid, legacy due before, Nest due after]
 */
const MONEY: Record<string, [string, number, number, number, number, number, number]> = {
  "registration.paid": ["PAID", 250, 250, 0, 250, 0, 0],
  "registration.partial": ["PARTIAL", 270, 270, 0, 100, 170, 170],
  "registration.verifying": ["VERIFYING", 170, 170, 0, 0, 170, 170],
  // Code priced at signup, never linked: legacy showed 0 due, Nest the breakdown's 50.
  "registration.signupCode": ["PENDING", 50, 250, 200, 0, 0, 50],
  // The same code linked by an admin afterwards: see the 0011 test below.
  "registration.signupCodeThenLinked": ["SPONSORED", 80, 280, 80, 0, 0, 200],
  "registration.linkedGross": ["SPONSORED", 250, 250, 250, 0, 0, 0],
  "registration.linkedPartial": ["PARTIAL", 290, 290, 170, 0, 120, 120],
  "registration.linkedThenEdited": ["PARTIAL", 130, 330, 200, 0, 0, 130],
  "registration.editedWithDrop": ["PENDING", 250, 250, 0, 0, 250, 250],
  "registration.signupCodeFull": ["PENDING", 0, 200, 200, 0, 0, 0],
  "registration.waived": ["WAIVED", 280, 280, 0, 0, 280, 280],
  "registration.refunded": ["REFUNDED", 250, 250, 0, 250, 0, 0],
  "registration.speaker": ["PENDING", 200, 200, 0, 0, 200, 200],
  "registration.paidOnline": ["PAID", 390, 390, 0, 390, 0, 0],
  "registration.pastPaid": ["PAID", 140, 140, 0, 140, 0, 0],
  "registration.pastAdminPaid": ["PAID", 100, 100, 0, 0, 100, 100],
  "registration.pastPending": ["PENDING", 100, 100, 0, 0, 100, 100],
};

/** The rows 0011 rewrites: the README query's rows, total_amount -> breakdown subtotal. */
const GROSS_REPAIRED = [
  { id: "registration.linkedThenEdited", total: 130, subtotal: 330 },
  { id: "registration.signupCode", total: 50, subtotal: 250 },
  { id: "registration.signupCodeFull", total: 0, subtotal: 200 },
  { id: "registration.signupCodeThenLinked", total: 80, subtotal: 280 },
];

function touched(table: string, row: string, column: string, before: string, after: string): CellChange {
  return { table, row, column, before, after };
}

/** Every value the cutover changes in a legacy column, and nothing else. */
const EXPECTED_CHANGES: CellChange[] = [
  // 0006: two active themes in one sort_order slot; the one with issued codes
  // keeps it, the others move above the config's largest slot (inactive themes count).
  touched("abstract_themes", "theme.ablation", "sort_order", "0", "2"),
  touched("abstract_themes", "theme.ablation", "updated_at", "2026-02-10 12:12:00", MIGRATION_TIME),
  touched("abstract_themes", "theme.holter", "sort_order", "0", "1"),
  touched("abstract_themes", "theme.holter", "updated_at", "2026-02-10 12:11:00", MIGRATION_TIME),
  touched("abstract_themes", "theme.rhythm", "sort_order", "2", "5"),
  touched("abstract_themes", "theme.rhythm", "updated_at", "2026-05-22 09:11:00", MIGRATION_TIME),
  // 0011: net -> gross total_amount; 0030: codes trimmed and upper-cased.
  touched("registrations", "registration.linkedThenEdited", "total_amount", "130", "330"),
  touched("registrations", "registration.linkedThenEdited", "updated_at", "2026-06-20 17:45:30.3", MIGRATION_TIME),
  touched("registrations", "registration.signupCode", "sponsorship_code", " sp-k7m2 ", "SP-K7M2"),
  touched("registrations", "registration.signupCode", "total_amount", "50", "250"),
  touched("registrations", "registration.signupCode", "updated_at", "2026-06-07 13:05:44.25", MIGRATION_TIME),
  touched("registrations", "registration.signupCodeFull", "sponsorship_code", "sp-f9q3", "SP-F9Q3"),
  touched("registrations", "registration.signupCodeFull", "total_amount", "0", "200"),
  touched("registrations", "registration.signupCodeFull", "updated_at", "2026-06-14 10:00:00.01", MIGRATION_TIME),
  touched("registrations", "registration.signupCodeThenLinked", "total_amount", "80", "280"),
  touched("registrations", "registration.signupCodeThenLinked", "updated_at", "2026-06-12 09:30:00.5", MIGRATION_TIME),
];

// ============================================================================
// The cutover
// ============================================================================

describe.runIf(dbTestsEnabled())("legacy production data across the cutover", () => {
  describe("main's data in every legacy table: adopt, apply, verify", () => {
    let database: ScratchDatabase;
    let migrations: MigrationDefinition[];
    let legacyTables: string[];
    let before: DatabaseSnapshot;
    let moneyBefore: Map<string, MoneyRow>;
    let invariantsBefore: Record<string, string[]>;
    let cutoverStartedAt: Date;

    beforeAll(async () => {
      database = await createSeededLegacyDatabase("legacy_data");
      migrations = await loadMigrations(defaultMigrationsDirectory(), database.engine);
      legacyTables = await publicTables(database.client);
      before = await snapshotTables(database.client, legacyTables);
      moneyBefore = await moneyRows(database.client);
      await useDatabase(database);
      configureJsonbValidation("enforce");
      invariantsBefore = problems(await checkSettlementInvariants());
    }, dbTestSetupTimeoutMs());

    afterAll(async () => {
      configureJsonbValidation(undefined);
      await releaseDatabase();
      await database?.close();
    }, dbTestSetupTimeoutMs());

    it("seeds every table of the legacy schema", () => {
      expect(legacyTables).toHaveLength(31);
      const empty = Object.entries(rowCounts(before)).filter(([, count]) => count === 0);
      expect(empty).toEqual([]);
    });

    it("adopt dry run writes nothing; adopt --apply writes only the ledger", async () => {
      const options = { appliedBy: "legacy-data-test", leaseConnectionString: database.url };
      const dryRun = await adoptMigrations(database.client, database.engine, migrations, { ...options, writeLedger: false }, migrationAdoptionSupport);
      expect(dryRun.errors).toEqual([]);
      expect(dryRun.aborted).toBe(false);
      expect(dryRun.written).toEqual({ migrations: 0, steps: 0 });
      expect(diffSnapshots(before, await snapshotTables(database.client, legacyTables)).changes).toEqual([]);

      const applied = await adoptMigrations(database.client, database.engine, migrations, { ...options, writeLedger: true }, migrationAdoptionSupport);
      expect(applied.errors).toEqual([]);
      // The rows the empty fixture gets (legacy-prisma-adopt): data changes no verdict.
      expect(applied.written).toEqual({ migrations: 7, steps: 0 });
      const diff = diffSnapshots(before, await snapshotTables(database.client, legacyTables));
      expect(diff).toEqual({ droppedTables: [], droppedColumns: [], retypedColumns: [], droppedRows: [], addedRows: [], changes: [] });
      // 0011 and 0030 stay pending: apply runs them.
      expect((await listMigrationRecords(database.client)).map((record) => [record.id, record.status])).toEqual([
        ["0000", "baseline"],
        ["0001", "applied"],
        ["0002", "applied"],
        ["0007", "applied"],
        ["0008", "applied"],
        ["0009", "applied"],
        ["0010", "applied"],
      ]);
    }, dbTestSetupTimeoutMs());

    it("the README's 0011 query (rollout step 4) lists exactly the net totals 0011 rewrites", async () => {
      expect(await readme0011Rows(database.client)).toEqual(GROSS_REPAIRED);
      // One of them will owe more than it was quoted (see the 0011 test).
      const overQuote = await database.client.query<{ id: string; total_amount: number; sponsorship_amount: number; quoted_sponsorship: number }>(
        OVER_QUOTE_0011_QUERY,
      );
      expect(overQuote.rows.map((row) => [nameOf(row.id), Number(row.total_amount), Number(row.sponsorship_amount), Number(row.quoted_sponsorship)])).toEqual([
        ["registration.signupCodeThenLinked", 80, 80, 200],
      ]);
      // The same row is not listed once its event has ended or is archived.
      await database.client.query("BEGIN");
      try {
        await database.client.query("UPDATE events SET end_date = now() - INTERVAL '1 day' WHERE id = $1", [LEGACY_IDS.event.congress]);
        expect((await database.client.query(OVER_QUOTE_0011_QUERY)).rows).toEqual([]);
        await database.client.query("UPDATE events SET end_date = '2036-11-22 18:00:00', status = 'ARCHIVED' WHERE id = $1", [LEGACY_IDS.event.congress]);
        expect((await database.client.query(OVER_QUOTE_0011_QUERY)).rows).toEqual([]);
      } finally {
        await database.client.query("ROLLBACK");
      }
      expect((await database.client.query(OVER_QUOTE_0011_QUERY)).rows).toHaveLength(1);
    });

    it("apply --dry-run writes nothing; apply runs what it listed, defers none; verify --schema reports no error", async () => {
      // As the CLI runs them (cli.ts apply): the lease heartbeat on its own connection.
      const options = { appliedBy: "legacy-data-test", leaseConnectionString: database.url };
      const ledger = await listMigrationRecords(database.client);
      const dryRun = await applyMigrations(database.client, migrations, { ...options, dryRun: true });
      expect(dryRun.deferred).toEqual([]);
      expect(await listMigrationRecords(database.client)).toEqual(ledger);
      expect(diffSnapshots(before, await snapshotTables(database.client, legacyTables)).changes).toEqual([]);

      cutoverStartedAt = new Date();
      const result = await applyMigrations(database.client, migrations, options);
      expect(result.deferred).toEqual([]);
      // The dry run listed every migration apply ran; on CockroachDB 0017's
      // condition waits for networking_embeddings, which 0013 creates.
      const listed = [...dryRun.applied, ...dryRun.unknownPreconditions.map((line) => line.split(" ")[0]!)];
      expect([...result.applied].sort()).toEqual(listed.sort());
      expect(result.applied).toEqual(expect.arrayContaining(["0004", "0006", "0011", "0030", "0033"]));
      const verification = await verifyMigrations(database.client, database.engine, migrations, { schema: true });
      expect(verification.errors).toEqual([]);
      expect(verification.warnings).toEqual(["Migration 0011 has no catalog probes"]);
      // Re-running 0011 now changes nothing.
      expect(await readme0011Rows(database.client)).toEqual([]);
    }, dbTestSetupTimeoutMs());

    it("keeps every table, column and row; changes only the documented values", async () => {
      const after = await snapshotTables(database.client, legacyTables);
      const diff = diffSnapshots(before, after);
      expect(diff.droppedTables).toEqual(["abstract_code_sequences"]); // 0033
      expect(diff.droppedColumns).toEqual([]);
      expect(diff.retypedColumns).toEqual([]);
      expect(diff.droppedRows).toEqual([]);
      expect(diff.addedRows).toEqual([]);
      expect(withMigrationTimes(diff.changes)).toEqual(EXPECTED_CHANGES);
      // 0030 only reformats a code: the stored value is its normalized form.
      for (const change of diff.changes.filter((cell) => cell.column === "sponsorship_code")) {
        expect([change.row, change.after]).toEqual([change.row, normalizeSponsorshipCode(change.before)]);
      }
      // 0011 only moves a net total to its breakdown's subtotal.
      for (const change of diff.changes.filter((cell) => cell.column === "total_amount")) {
        const stored = JSON.parse(before.registrations!.rows.get(change.row)!.price_breakdown!) as { subtotal: number };
        expect([change.row, change.after]).toEqual([change.row, String(stored.subtotal)]);
      }

      const counts = rowCounts(before);
      delete counts.abstract_code_sequences;
      expect(rowCounts(after)).toEqual(counts);
    });

    it("keeps the microseconds of check-in timestamps (0010 does not rewrite them)", async () => {
      const result = await database.client.query<{ id: string; at: string }>(
        `SELECT id, (checked_in_at AT TIME ZONE 'UTC')::TEXT AS at FROM access_check_ins
         UNION ALL
         SELECT id, (checked_in_at AT TIME ZONE 'UTC')::TEXT FROM registrations WHERE checked_in_at IS NOT NULL
         ORDER BY at`,
      );
      expect(result.rows.map((row) => [nameOf(row.id), row.at])).toEqual([
        [nameOf(reg.pastPaid), "2026-04-10 08:31:12.123456"],
        [nameOf(reg.pastAdminPaid), "2026-04-10 08:45:59.999999"],
        [expect.stringMatching(/^0000000c-/), "2026-04-10 09:12:33.654321"],
        [expect.stringMatching(/^0000000c-/), "2026-04-10 12:30:00.000001"],
        [expect.stringMatching(/^0000000c-/), "2026-04-10 12:31:45.5"],
      ]);
    });

    it("0011: total_amount net -> gross on exactly the README rows; the amount due follows", async () => {
      const after = await moneyRows(database.client);
      const repaired = new Set(GROSS_REPAIRED.map((row) => row.id));
      for (const [name, [status, totalBefore, totalAfter, sponsorship, paid, legacyDue, nestDue]] of Object.entries(MONEY)) {
        const old = moneyBefore.get(name)!;
        const now = after.get(name)!;
        expect([name, old.status, old.total, old.sponsorship, old.paid]).toEqual([name, status, totalBefore, sponsorship, paid]);
        expect([name, now.status, now.total, now.sponsorship, now.paid]).toEqual([name, status, totalAfter, sponsorship, paid]);
        // Legacy's own settlement on the legacy row, Nest's on the migrated row.
        expect([name, legacyCalculateSettlement({ totalAmount: old.total, paidAmount: old.paid, sponsorshipAmount: old.sponsorship }).amountDue]).toEqual([name, legacyDue]);
        expect([name, calculateSettlement({ totalAmount: now.total, paidAmount: now.paid, sponsorshipAmount: now.sponsorship }).amountDue]).toEqual([name, nestDue]);
        if (!repaired.has(name)) expect([name, nestDue]).toEqual([name, legacyDue]);
      }
      expect(Object.keys(MONEY).sort()).toEqual([...after.keys()].sort());

      // On a repaired row Nest's due is the breakdown's net minus paid, what
      // the registrant was quoted, except where an admin then linked the
      // code: the link capped the usage at the stored net total (80,
      // sponsorship-math.ts:71-75, sponsorship-linking.ts:571-662), so the
      // gross total now leaves 200 due instead of 80 (open issue).
      const quoted = await database.client.query<{ id: string; total: number; paid_amount: number }>(
        `SELECT id, (price_breakdown->>'total')::INT AS total, paid_amount FROM registrations WHERE id = ANY($1)`,
        [GROSS_REPAIRED.map((row) => NAMES_TO_IDS.get(row.id)!)],
      );
      const dueVersusQuote = quoted.rows
        .map((row) => [nameOf(row.id), Math.max(0, Number(row.total) - Number(row.paid_amount)), MONEY[nameOf(row.id)]![6]])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      expect(dueVersusQuote).toEqual([
        ["registration.linkedThenEdited", 130, 130],
        ["registration.signupCode", 50, 50],
        ["registration.signupCodeFull", 0, 0],
        ["registration.signupCodeThenLinked", 80, 200],
      ]);
    });

    it("0033 drops a sequence value no counter or code holds; Nest's next codes continue each theme's counter and reuse no issued code", async () => {
      // Neither Nest nor main since a4545064 reads the table (main's only
      // reference is abstracts.admin.service.test.ts:137, asserting it is not
      // called). Before 0033 the POSTER sequence (2) was in no counter and no
      // stored code any more: the abstract that took PC2-02 was reopened, and
      // the imaging counter moved on to 3. Only a pre-cutover copy keeps it.
      const sequences = before.abstract_code_sequences!;
      expect([...sequences.rows.values()].map((row) => [row.final_type, row.last_value]).sort()).toEqual([
        ["ORAL_COMMUNICATION", "3"],
        ["POSTER", "2"],
      ]);
      const posterNumbers = [
        ...[...before.abstract_code_counters!.rows.values()].filter((row) => row.final_type === "POSTER").map((row) => row.last_value),
        ...[...before.abstracts!.rows.values()].filter((row) => row.final_type === "POSTER" && row.code_number !== null).map((row) => row.code_number),
      ];
      expect(posterNumbers.sort()).toEqual(["1", "1", "3", "3"]);

      // Nest allocates from the theme counter and the largest stored number
      // (packages/db/src/queries/abstracts/decisions.ts allocateAbstractCode),
      // as main does (abstracts.admin.service.ts:110-155): the next code never
      // reuses a stored or reopened number. 0006 moved rhythm to slot 5 and
      // holter to slot 1, so their new codes no longer collide with imaging's
      // and ECG's.
      const finalize = (abstractId: string, finalType: "ORAL_COMMUNICATION" | "POSTER", eventId = ids.event.congress) =>
        finalizeAbstractTxn({ eventId, abstractId, decision: "ACCEPTED", finalType, performedBy: ids.user.admin });
      expect(await finalize(ids.abstract.submittedImaging, "ORAL_COMMUNICATION")).toEqual({ ok: true });
      expect(await finalize(ids.abstract.reopened, "POSTER")).toEqual({ ok: true });
      expect(await finalize(ids.abstract.underReviewRhythm, "ORAL_COMMUNICATION")).toEqual({ ok: true });
      expect(await finalize(ids.abstract.reviewComplete, "ORAL_COMMUNICATION")).toEqual({ ok: true });
      expect(await finalize(ids.abstract.submittedInterventional, "POSTER")).toEqual({ ok: true });
      expect(await finalize(ids.abstract.pastSubmitted, "POSTER", ids.event.pastDays)).toEqual({ ok: true });

      const codes = await database.client.query<{ id: string; event_id: string; code: string }>(
        "SELECT id, event_id, code FROM abstracts WHERE code IS NOT NULL",
      );
      // Every code issued before the cutover: the stored ones and those a reopen took back.
      const issued = new Set([
        ...[...before.abstracts!.rows.values()].flatMap((row) => (row.code ? [row.code] : [])),
        ...[...before.audit_logs!.rows.values()]
          .filter((row) => row.action === "reopen")
          .map((row) => (JSON.parse(row.changes!) as { code: { old: string } }).code.old),
      ]);
      expect([...issued].sort()).toEqual(["OC0-01", "OC0-02", "OC1-03", "OC2-01", "OC2-02", "OC2-03", "PC0-01", "PC2-03"]);
      const fresh = codes.rows.filter((row) => !before.abstracts!.rows.get(nameOf(row.id))!.code);
      expect(fresh).toHaveLength(6);
      expect(fresh.filter((row) => issued.has(row.code))).toEqual([]);
      const byEventAndCode = (a: { event_id: string; code: string }, b: { event_id: string; code: string }) =>
        a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
      expect(codes.rows.sort(byEventAndCode).map((row) => [nameOf(row.id), row.code])).toEqual([
        ["abstract.sequenceEra", "OC1-03"],
        ["abstract.reviewComplete", "OC1-04"],
        ["abstract.acceptedOral", "OC2-01"],
        ["abstract.acceptedOral2", "OC2-02"],
        ["abstract.submittedImaging", "OC2-04"],
        ["abstract.underReviewRhythm", "OC5-01"],
        ["abstract.submittedInterventional", "PC1-01"],
        ["abstract.acceptedPoster", "PC2-03"],
        ["abstract.reopened", "PC2-04"],
        ["abstract.pastOral1", "OC0-01"],
        ["abstract.pastOral2", "OC0-02"],
        ["abstract.pastPoster", "PC0-01"],
        ["abstract.pastSubmitted", "PC1-02"],
      ]);
    });

    it("ECG kept the slot it shared with Holter: its first poster code is Holter's PC0-01, refused as on main", async () => {
      // Not from the cutover: on main both themes sit in slot 0, and the same
      // allocator (abstracts.admin.service.ts:110-155) gives ECG's first
      // poster PC0-01 too (no ECG POSTER counter or code). 0006 moved Holter,
      // the theme with fewer issued codes, but its printed codes keep slot 0.
      // The unique (event_id, code) refuses the duplicate; Nest reports
      // code_conflict and rolls the counter back.
      expect(
        await finalizeAbstractTxn({
          eventId: ids.event.pastDays,
          abstractId: ids.abstract.pastSubmittedEcg,
          decision: "ACCEPTED",
          finalType: "POSTER",
          performedBy: ids.user.admin,
        }),
      ).toEqual({ ok: false, reason: "code_conflict" });
      const after = await database.client.query<{ status: string; code: string | null; counters: string }>(
        `SELECT a.status::TEXT AS status, a.code,
                (SELECT count(*) FROM abstract_code_counters c WHERE c.theme_id = $2 AND c.final_type = 'POSTER')::TEXT AS counters
         FROM abstracts a WHERE a.id = $1`,
        [ids.abstract.pastSubmittedEcg, ids.theme.ecg],
      );
      expect(after.rows).toEqual([{ status: "SUBMITTED", code: null, counters: "0" }]);
    });

    it("reference numbers continue after the legacy ones", async () => {
      const next = (eventId: string) => getDb().transaction((tx) => allocateReferenceNumber(eventId, tx));
      expect(await next(ids.event.congress)).toBe("36-CONGRES-CARD-015");
      expect(await next(ids.event.pastDays)).toBe("26-RYTHMO-2026-004");
    });

    it("reads the migrated registrations: list, detail and settlement", async () => {
      const list = await listRegistrationRows(ids.event.congress, { limit: 50, offset: 0 });
      expect(list.total).toBe(14);
      const congress = Object.entries(MONEY).filter(([name]) => !name.startsWith("registration.past"));
      const expectedStats = new Map<string, { paymentStatus: string; cnt: number; totalAmount: number; paidAmount: number; amountDue: number }>();
      for (const [, [status, , total, , paid, , due]] of congress) {
        const stat = expectedStats.get(status) ?? { paymentStatus: status, cnt: 0, totalAmount: 0, paidAmount: 0, amountDue: 0 };
        stat.cnt += 1;
        stat.totalAmount += total;
        stat.paidAmount += paid;
        stat.amountDue += due;
        expectedStats.set(status, stat);
      }
      const byStatus = (a: { paymentStatus: string }, b: { paymentStatus: string }) => a.paymentStatus.localeCompare(b.paymentStatus);
      expect([...list.stats].sort(byStatus)).toEqual([...expectedStats.values()].sort(byStatus));
      expect(list.data.map((row) => nameOf(row.id))).toEqual(
        [...congress.map(([name]) => name)].sort((a, b) => {
          const created = (name: string) => before.registrations!.rows.get(name)!.created_at!;
          return created(b).localeCompare(created(a));
        }),
      );

      const detail = await getRegistrationByIdRow(reg.pastPaid);
      expect(detail).toMatchObject({
        referenceNumber: "26-RYTHMO-2026-001",
        paymentStatus: "PAID",
        totalAmount: 140,
        paidAmount: 140,
        priceBreakdown: { subtotal: 140, total: 140, accessItems: [expect.objectContaining({ status: "confirmed" }), expect.objectContaining({ status: "confirmed" })] },
        event: { slug: "rythmo-2026" },
      });
      expect((detail?.accessCheckIns ?? []).map((checkIn) => checkIn.checkedInAt?.toISOString()).sort()).toEqual([
        "2026-04-10T09:12:33.654Z",
        "2026-04-10T12:30:00.000Z",
      ]);
    });

    it("reads the public forms, certificate templates and the abstracts admin list", async () => {
      const form = await findRegistrationFormByEventSlug("congres-cardio-2036");
      expect(form?.id).toBe(ids.form.congress);
      expect(form?.schema).toEqual(JSON.parse(before.forms!.rows.get("form.congress")!.schema!));
      expect(form?.event.pricing?.rules).toEqual(JSON.parse(before.event_pricing!.rows.get("pricing.congress")!.rules!));
      expect(form?.event.access.map((access) => nameOf(access.id))).toEqual([
        "access.plenary",
        "access.workshop",
        "access.dinner",
        "access.night1",
        "access.night2",
      ]);
      const sponsorForm = await findSponsorFormByEventSlug("congres-cardio-2036");
      expect(sponsorForm?.id).toBe(ids.form.congressSponsor);

      const templates = await listCertificateTemplates(ids.event.pastDays);
      expect(templates.map((template) => [nameOf(template.id), template.zones.length])).toEqual([
        ["certificate.workshop", 2],
        ["certificate.attendance", 3],
        ["certificate.retired", 0],
      ]);
      const workshop = await getCertificateTemplateWithEvent(ids.certificate.workshop);
      expect(workshop).toMatchObject({
        applicableRoles: ["PARTICIPANT", "SPEAKER"],
        access: { id: ids.access.pastWorkshop, name: "Atelier ECG" },
        event: { status: "CLOSED" },
      });

      const abstracts = await listAdminAbstracts(ids.event.congress, { limit: 50, offset: 0 });
      expect(abstracts.total).toBe(11);
      const rejected = abstracts.items.find((item) => item.id === ids.abstract.rejected)!;
      expect(rejected.themes.map((theme) => theme.sortOrder)).toEqual([2, 4]);
    });

    it("stored JSON: every legacy document passes the audit's checks", async () => {
      const findings = await storedJsonFindings();
      expect(findings).toEqual({
        "event_pricing.rules": { scanned: 2, invalid: [] },
        "certificate_templates.zones": { scanned: 3, invalid: [] },
        "forms.schema": { scanned: 4, invalid: [] },
        "email_logs.context_snapshot": { scanned: 17, invalid: [] },
        "registrations.price_breakdown": { scanned: 17, invalid: [] },
      });
    });

    it("recovers the legacy leases and claims the queued legacy emails", async () => {
      expect(await emailQueue.recoverStale()).toEqual({ requeued: 1, deadLettered: 0, uncertain: 0 });
      expect(await outboxQueue.recoverStale()).toEqual({ requeued: 1, deadLettered: 0 });
      expect(await abstractBookQueue.recoverStale()).toEqual({ requeued: 1, deadLettered: 0 });

      const claimed = await emailQueue.claim("legacy-data-test", 10);
      const logs = await getClaimedEmailLogsForProcessing("legacy-data-test", claimed);
      expect(logs.map((log) => nameOf(log.id))).toEqual(["emailLog.queuedRetry", "emailLog.queued", "emailLog.manualQueued"]);
      for (const log of logs) {
        expect(readEmailContextSnapshot(log.contextSnapshot, log.id)).toBe(log.contextSnapshot);
        expect(log.template?.id).toBe(log.templateId);
        expect(log.registration?.id).toBe(log.registrationId);
      }
    });

    it("settlement invariants: legacy rows, the migrated rows, and what the documented repairs leave", async () => {
      // Before: legacy's net totals.
      expect(invariantsBefore).toEqual({
        breakdown_vs_columns: [
          "registration.linkedGross SPONSORSHIP_TOTAL_MISMATCH",
          "registration.linkedPartial SPONSORSHIP_TOTAL_MISMATCH",
          "registration.linkedThenEdited SUBTOTAL_EXCEEDS_TOTAL_AMOUNT",
          "registration.signupCode SUBTOTAL_EXCEEDS_TOTAL_AMOUNT",
          "registration.signupCodeFull SUBTOTAL_EXCEEDS_TOTAL_AMOUNT",
          "registration.signupCodeThenLinked SPONSORSHIP_TOTAL_MISMATCH",
        ],
        status_vs_amounts: [
          "registration.linkedThenEdited SPONSORSHIP_EXCEEDS_TOTAL",
          "registration.pastAdminPaid PAID_BELOW_NET",
          "registration.signupCode SPONSORSHIP_EXCEEDS_TOTAL",
          "registration.signupCodeFull SPONSORSHIP_EXCEEDS_TOTAL",
        ],
        sponsorship_vs_usages: ["registration.signupCode AMOUNT_WITHOUT_USAGE", "registration.signupCodeFull AMOUNT_WITHOUT_USAGE"],
        duplicate_codes: [],
        count_drift: [],
      });

      // After apply, before any data repair.
      expect(problems(await checkSettlementInvariants())).toEqual({
        breakdown_vs_columns: [
          "registration.linkedGross SPONSORSHIP_TOTAL_MISMATCH",
          "registration.linkedPartial SPONSORSHIP_TOTAL_MISMATCH",
          "registration.signupCodeThenLinked SPONSORSHIP_TOTAL_MISMATCH",
        ],
        status_vs_amounts: [
          "registration.pastAdminPaid PAID_BELOW_NET",
          "registration.signupCode PENDING_WITH_SPONSORSHIP",
          "registration.signupCodeFull PENDING_FULLY_SPONSORED",
          "registration.signupCodeThenLinked SPONSORED_NOT_COVERED",
        ],
        sponsorship_vs_usages: ["registration.signupCode AMOUNT_WITHOUT_USAGE", "registration.signupCodeFull AMOUNT_WITHOUT_USAGE"],
        duplicate_codes: [],
        count_drift: [],
      });

      // Data repairs (production-rollout-checklist.md). Sponsorship codes: two
      // links; the admin-linked code counts as done and is left as it is.
      const plan = await planSponsorshipCodeRepair();
      expect(plan.decisions).toEqual([]);
      expect(plan.alreadyLinked).toBe(1);
      expect(plan.links.map((link) => [nameOf(link.registrationId), link.code, link.after])).toEqual([
        ["registration.signupCode", "SP-K7M2", { paymentStatus: "PARTIAL", sponsorshipAmount: 200, amountDue: 50 }],
        ["registration.signupCodeFull", "SP-F9Q3", { paymentStatus: "SPONSORED", sponsorshipAmount: 200, amountDue: 0 }],
      ]);
      for (const link of plan.links) expect(await applySponsorshipCodeLink(link)).toMatchObject({ outcome: "linked" });

      // PAID settlement: the admin-created PAID row without a payment is section A.
      const paid = await planPaidSettlementRepair({ since: cutoverStartedAt });
      expect(paid.candidates.map((candidate) => [nameOf(candidate.id), candidate.section, candidate.proposedAction])).toEqual([
        ["registration.pastAdminPaid", "A", "BACKFILL_PAID"],
      ]);
      const [candidate] = paid.candidates;
      const approved = { id: candidate!.id, section: candidate!.section, action: candidate!.proposedAction!, expected: candidate!.expected };
      expect(await applyPaidRepairRow(approved, { since: cutoverStartedAt })).toMatchObject({
        outcome: "applied",
        after: { paymentStatus: "PAID", paidAmount: 100 },
      });

      expect(problems(await checkSettlementInvariants())).toEqual({
        breakdown_vs_columns: [
          "registration.linkedGross SPONSORSHIP_TOTAL_MISMATCH",
          "registration.linkedPartial SPONSORSHIP_TOTAL_MISMATCH",
          "registration.signupCodeThenLinked SPONSORSHIP_TOTAL_MISMATCH",
        ],
        status_vs_amounts: ["registration.signupCodeThenLinked SPONSORED_NOT_COVERED"],
        sponsorship_vs_usages: [],
        duplicate_codes: [],
        count_drift: [],
      });

      // What is left needs a settlement write, which no documented repair
      // makes (open issue). Settling the admin-linked code again recomputes
      // its usage from the gross total: 200 sponsored, 80 due, as quoted.
      await withLockingTxn((tx) => settleRegistrationTxn(tx, reg.signupCodeThenLinked));
      await withLockingTxn((tx) => settleRegistrationTxn(tx, reg.linkedGross));
      await withLockingTxn((tx) => settleRegistrationTxn(tx, reg.linkedPartial));
      const settled = (await moneyRows(database.client)).get("registration.signupCodeThenLinked")!;
      expect(settled).toMatchObject({ status: "PARTIAL", total: 280, sponsorship: 200, paid: 0 });
      expect(calculateSettlement({ totalAmount: settled.total, paidAmount: settled.paid, sponsorshipAmount: settled.sponsorship }).amountDue).toBe(80);
      const report = await checkSettlementInvariants();
      expect(problems(report)).toEqual({
        breakdown_vs_columns: [],
        status_vs_amounts: [],
        sponsorship_vs_usages: [],
        duplicate_codes: [],
        count_drift: [],
      });
      expect(report.ok).toBe(true);
    });
  });

  // The two states of legacy data that stop or defer a migration. 0004 adds a
  // unique index on unfinished abstract-book jobs that legacy never enforced;
  // 0030 one on signup codes, which it defers while one is stored twice.
  describe("two unfinished book jobs in an event and a signup code stored twice", () => {
    let database: ScratchDatabase;
    let migrations: MigrationDefinition[];
    let legacyTables: string[];
    let before: DatabaseSnapshot;

    beforeAll(async () => {
      database = await createSeededLegacyDatabase("legacy_data_dup", {
        duplicateSponsorshipCode: true,
        duplicateActiveBookJob: true,
      });
      migrations = await loadMigrations(defaultMigrationsDirectory(), database.engine);
      legacyTables = await publicTables(database.client);
      before = await snapshotTables(database.client, legacyTables);
      await useDatabase(database);
      const adopted = await adoptMigrations(
        database.client,
        database.engine,
        migrations,
        { writeLedger: true, appliedBy: "legacy-data-test", leaseConnectionString: database.url },
        migrationAdoptionSupport,
      );
      expect(adopted.errors).toEqual([]);
    }, dbTestSetupTimeoutMs());

    afterAll(async () => {
      await releaseDatabase();
      await database?.close();
    }, dbTestSetupTimeoutMs());

    const applyOptions = () => ({ appliedBy: "legacy-data-test", leaseConnectionString: database.url });

    it("apply --dry-run cannot see 0004's duplicate; apply stops at 0004 and changes no legacy value", async () => {
      // The dry run evaluates defer-unless conditions only: it defers 0030 and
      // lists 0004, whose unique index the second unfinished job then refuses.
      const dryRun = await applyMigrations(database.client, migrations, { ...applyOptions(), dryRun: true });
      expect(dryRun.applied).toContain("0004");
      expect(dryRun.deferred).toEqual(["0030"]);
      await expect(applyMigrations(database.client, migrations, applyOptions())).rejects.toMatchObject({
        code: "23505",
      });
      const records = await listMigrationRecords(database.client);
      expect(records.find((record) => record.id === "0003")?.status).toBe("applied");
      expect(records.find((record) => record.id === "0004")).toBeUndefined();
      const diff = diffSnapshots(before, await snapshotTables(database.client, legacyTables));
      expect(diff).toEqual({ droppedTables: [], droppedColumns: [], retypedColumns: [], droppedRows: [], addedRows: [], changes: [] });
    }, dbTestSetupTimeoutMs());

    it("once the duplicate job is finished, apply resumes; 0030 is deferred and both codes stay as typed", async () => {
      // What an operator does: let the legacy worker drain the jobs, or fail the extra one.
      await database.client.query(
        `UPDATE abstract_book_jobs SET status = 'FAILED', error_message = 'Duplicate of an earlier request (cutover)'
         WHERE id = $1`,
        [ids.bookJob.secondPending],
      );
      const result = await applyMigrations(database.client, migrations, applyOptions());
      expect(result.applied[0]).toBe("0004");
      expect(result.deferred).toEqual(["0030"]);
      expect(result.applied).toContain("0031");
      const verification = await verifyMigrations(database.client, database.engine, migrations, { schema: true });
      expect(verification.errors).toEqual([]);
      expect(verification.warnings).toEqual(expect.arrayContaining([expect.stringContaining("0030")]));

      const diff = diffSnapshots(before, await snapshotTables(database.client, legacyTables));
      expect(diff.droppedTables).toEqual(["abstract_code_sequences"]);
      expect(diff.droppedColumns).toEqual([]);
      expect(diff.droppedRows).toEqual([]);
      expect(diff.addedRows).toEqual([]);
      expect(diff.changes.filter((change) => change.column === "sponsorship_code")).toEqual([]);
      expect(diff.changes.filter((change) => change.column === "total_amount").map((change) => change.row)).toEqual(
        [...GROSS_REPAIRED.map((row) => row.id), "registration.duplicateCode"].sort(),
      );
      expect(diff.changes.filter((change) => change.table === "abstract_book_jobs").map((change) => [change.row, change.column])).toEqual([
        ["bookJob.secondPending", "error_message"],
        ["bookJob.secondPending", "status"],
      ]);
    }, dbTestSetupTimeoutMs());

    it("the invariants and the repair plan name the two claimants; clearing one lets 0030 apply", async () => {
      expect(problems(await checkSettlementInvariants()).duplicate_codes).toEqual(["SP-K7M2 CODE_STORED_BY_SEVERAL"]);
      const plan = await planSponsorshipCodeRepair();
      expect(plan.decisions.map((decision) => [decision.reason, decision.code, decision.registrationIds.map(nameOf)])).toEqual([
        ["SEVERAL_CLAIMANTS", "SP-K7M2", ["registration.signupCode", "registration.duplicateCode"]],
      ]);

      const cleared = await clearRegistrationSponsorshipCode(reg.duplicateCode, { apply: true });
      expect(cleared).toMatchObject({ outcome: "cleared", code: "SP-K7M2 " });
      const result = await applyMigrations(database.client, migrations, { ...applyOptions(), applyDeferred: "0030" });
      expect(result.applied).toEqual(["0030"]);
      const codes = await database.client.query<{ id: string; sponsorship_code: string | null }>(
        "SELECT id, sponsorship_code FROM registrations WHERE sponsorship_code IS NOT NULL ORDER BY sponsorship_code",
      );
      expect(codes.rows.map((row) => [nameOf(row.id), row.sponsorship_code])).toEqual([
        ["registration.signupCodeFull", "SP-F9Q3"],
        ["registration.signupCode", "SP-K7M2"],
        ["registration.signupCodeThenLinked", "SP-P4X9"],
      ]);
      expect((await verifyMigrations(database.client, database.engine, migrations, { schema: true })).errors).toEqual([]);
    }, dbTestSetupTimeoutMs());
  });
});

