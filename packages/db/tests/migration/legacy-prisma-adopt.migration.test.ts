import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import type { ScratchDatabase } from "@app/db/testing";
import { createScratchDatabase, dbTestsEnabled } from "@app/db/testing";
import {
  adoptMigrations,
  applyMigrations,
  defaultMigrationsDirectory,
  deriveCatalogProbes,
  formatAdoptionReport,
  listMigrationRecords,
  loadMigrations,
  migrationAdoptionSupport,
  migrationLedgerExists,
  verifyMigrations,
  type MigrationAdoptionReport,
  type MigrationDefinition,
} from "../../src/migrator";
import {
  assertSchemaCurrent,
  UnadoptedDatabaseError,
  type MigrationsCheckMode,
  type SchemaCheckLogger,
} from "../../src/schema-check";
import { dbTestSetupTimeoutMs } from "../../../vitest.shared";
import { createLegacyPrismaDatabase, writeLegacyPrismaLedger } from "../helpers/legacy-prisma";

// Adoption of the production database itself: the schema the Prisma app on
// main built (tests/migration/fixtures/legacy-prisma-schema.cockroach.sql),
// with Prisma's foreign key names, its db-push tables, columns and labels, and
// a `_prisma_migrations` table recording main's 31 migrations.

/**
 * What `adopt` decides on that schema, and why. A new migration is pending
 * here unless the legacy schema already has its objects.
 */
const LEGACY_VERDICTS: Record<string, "baseline" | "applied" | "pending"> = {
  "0000": "baseline", // 31 finished Prisma migrations; every probe matches, foreign keys under Prisma's names
  "0001": "applied", // main's migrations created these partial and inverted indexes
  "0002": "applied", // the index it drops is gone: main's 20260514000000 dropped it
  "0003": "pending", // email_logs outbox-delivery idempotency key: Nest only
  "0004": "pending", // one active abstract-book job per event: Nest only
  "0005": "pending", // certificate template scope: Nest only
  "0006": "pending", // unique active theme sort order: Nest only
  "0007": "applied", // main's 20260806000000 added the same translation columns
  "0008": "applied", // main's 20260814000000 created committee_invite_tokens
  "0009": "applied", // ...and its lookup index
  "0010": "applied", // check-in columns are TIMESTAMPTZ(6), which its verify accepts: no rewrite
  "0011": "pending", // a data repair with no catalog probe: apply runs it again (rollout step 4)
  "0012": "pending", // networking (0012-0019): never on main
  "0013": "pending",
  "0014": "pending",
  "0015": "pending",
  "0016": "pending",
  "0017": "pending", // CockroachDB only: the networking vector index
  "0018": "pending",
  "0019": "pending",
  "0020": "pending",
  "0021": "pending",
  "0022": "pending",
  "0023": "pending",
  "0024": "pending", // partial on an idempotent file: same index names, main's predicates; apply rebuilds them
  "0025": "pending",
  "0026": "pending",
  "0027": "pending",
  "0028": "pending", // EmailStatus has no UNCERTAIN yet (its verify is false)
  "0029": "pending",
  "0030": "pending",
  "0031": "pending",
  "0032": "pending",
  "0033": "pending", // abstract_code_sequences still exists; apply drops it
  "0034": "pending",
  "0035": "pending",
};

const PRISMA_EVIDENCE = { finished: 31, latest: "20260814000000_add_committee_invite_tokens" };

function classifications(report: MigrationAdoptionReport): Record<string, string> {
  return Object.fromEntries(
    report.assessments.map((assessment) => [assessment.migration.id, assessment.abort ? "ABORT" : assessment.classification!]),
  );
}

function expectedVerdicts(migrations: MigrationDefinition[]): Record<string, string> {
  return Object.fromEntries(
    migrations.map((migration) => [migration.id, LEGACY_VERDICTS[migration.id] ?? "missing from LEGACY_VERDICTS"]),
  );
}

const silent: SchemaCheckLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** The boot schema check on a fresh UTC-pinned session of the scratch database. */
async function bootCheck(url: string, mode: MigrationsCheckMode, production: boolean) {
  const session = new Client({ connectionString: url, options: "-c TimeZone=UTC" });
  await session.connect();
  return assertSchemaCurrent({
    mode,
    production,
    logger: silent,
    connect: async () => ({
      query: session.query.bind(session),
      release: () => void session.end(),
    }) as never,
  });
}

async function countRows(client: Client, table: string): Promise<number> {
  return Number((await client.query(`SELECT count(*) AS n FROM public."${table}"`)).rows[0].n);
}

async function countTables(client: Client): Promise<number> {
  const result = await client.query("SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public'");
  return Number(result.rows[0].n);
}

/** Removes `text` from the fixture, failing if it is not there. */
function without(text: string): (sql: string) => string {
  return (sql) => {
    if (!sql.includes(text)) throw new Error(`Fixture text not found: ${text}`);
    return sql.replace(text, "");
  };
}

describe.runIf(dbTestsEnabled())("migrate adopt on the legacy Prisma production schema", () => {
  const databases: ScratchDatabase[] = [];
  let migrations: MigrationDefinition[];

  function adopt(database: ScratchDatabase, writeLedger: boolean): Promise<MigrationAdoptionReport> {
    return adoptMigrations(
      database.client,
      database.engine,
      migrations,
      { writeLedger, appliedBy: "legacy-adopt-test", leaseConnectionString: database.url },
      migrationAdoptionSupport,
    );
  }

  afterAll(async () => {
    for (const database of databases) await database.close().catch(() => undefined);
  }, dbTestSetupTimeoutMs());

  describe("as main left it", () => {
    let database: ScratchDatabase;
    beforeAll(async () => {
      database = await createLegacyPrismaDatabase({ label: "legacy_prisma" });
      databases.push(database);
      migrations = await loadMigrations(defaultMigrationsDirectory(), database.engine);
    }, dbTestSetupTimeoutMs());

    it("classifies 0000 as baseline and each later migration as expected; the dry run writes nothing", async () => {
      const report = await adopt(database, false);
      expect(report.errors).toEqual([]);
      expect(report.aborted).toBe(false);
      expect(classifications(report)).toEqual(expectedVerdicts(migrations));
      expect(report.written).toEqual({ migrations: 0, steps: 0 });
      expect(await migrationLedgerExists(database.client)).toBe(false);

      const [baseline] = report.assessments;
      expect(baseline!.evidence.prisma).toEqual(PRISMA_EVIDENCE);
      const catalog = baseline!.evidence.catalog as { state: string; matched: number; total: number };
      expect(catalog.state).toBe("all");
      expect(catalog.matched).toBe(catalog.total);
      expect(report.warnings).toEqual([
        "0011 has no catalog probes; apply will run it again (declared idempotent)",
        ...(database.engine === "cockroach" ? ["0017 is deferrable; apply evaluates its defer-unless condition"] : []),
        "0030 is deferrable; apply evaluates its defer-unless condition",
        "Pending 0003, 0004, 0005, 0006 precede migrations already present; apply will run them after those",
      ]);
    });

    it("refuses to boot in production, whatever MIGRATIONS_CHECK says, until it is adopted", async () => {
      for (const mode of ["enforce", "warn", "off"] as const) {
        await expect(bootCheck(database.url, mode, true)).rejects.toBeInstanceOf(UnadoptedDatabaseError);
      }
      // Outside production the check keeps its mode: warn reports the missing ledger and continues.
      const warned = await bootCheck(database.url, "warn", false);
      expect(warned.errors).toEqual([
        "Migration ledger is missing; run migrate adopt for an existing database or apply on an empty database",
      ]);
      await expect(applyMigrations(database.client, migrations, { appliedBy: "legacy-adopt-test" })).rejects.toThrow(
        /run migrate adopt first/,
      );
    });

    it("--apply writes the ledger rows only; apply runs the pending migrations; the result verifies and boots", async () => {
      const tablesBefore = await countTables(database.client);
      const report = await adopt(database, true);
      expect(report.errors).toEqual([]);
      const adopted = Object.entries(expectedVerdicts(migrations)).filter(([, verdict]) => verdict !== "pending");
      expect(report.written).toEqual({ migrations: adopted.length, steps: 0 });
      const records = await listMigrationRecords(database.client);
      expect(records.map((record) => [record.id, record.status])).toEqual(adopted);
      expect((await countTables(database.client)) - tablesBefore).toBe(3); // the ledger, its steps and its lock

      const pending = Object.entries(expectedVerdicts(migrations))
        .filter(([, verdict]) => verdict === "pending")
        .map(([id]) => id);
      const result = await applyMigrations(database.client, migrations, { appliedBy: "legacy-adopt-test" });
      expect(result.applied).toEqual(pending);
      expect(result.deferred).toEqual([]);

      expect((await verifyMigrations(database.client, database.engine, migrations, { schema: true })).errors).toEqual([]);
      for (const mode of ["enforce", "off"] as const) {
        const check = await bootCheck(database.url, mode, true);
        expect(check.errors).toEqual([]);
        expect(check.warnings).toEqual([]);
      }

      // Adoption kept the production check-in timestamps as they were (0010 did not run).
      const precision = await database.client.query<{ table_name: string; datetime_precision: number }>(
        `SELECT table_name, datetime_precision FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name = 'checked_in_at' ORDER BY table_name`,
      );
      expect(precision.rows.map((row) => [row.table_name, Number(row.datetime_precision)])).toEqual([
        ["access_check_ins", 6],
        ["registrations", 6],
      ]);
      // The legacy ledger stays for the operator.
      expect(await countRows(database.client, "_prisma_migrations")).toBe(31);
    }, dbTestSetupTimeoutMs());
  });

  describe("without a column and an enum label that 0000 requires (db push drift)", () => {
    let database: ScratchDatabase;
    beforeAll(async () => {
      database = await createLegacyPrismaDatabase({
        label: "legacy_prisma_drift",
        edit: (sql) => without(`'PARTIAL', `)(without(`    "banner_url" STRING,\n`)(sql)),
      });
      databases.push(database);
      migrations = await loadMigrations(defaultMigrationsDirectory(), database.engine);
    }, dbTestSetupTimeoutMs());

    it("aborts adopt --apply, names exactly what is missing, and writes nothing", async () => {
      const report = await adopt(database, true);
      expect(report.aborted).toBe(true);
      expect(report.errors).toEqual([
        "0000: _prisma_migrations records a Prisma-managed schema, but the 0000 catalog probes do not all match",
      ]);
      const catalog = report.assessments[0]!.evidence.catalog as { state: string; matched: number; total: number; failed: string[] };
      expect(catalog.state).toBe("partial");
      expect(catalog.failed).toEqual(["label PaymentStatus.PARTIAL", "column events.banner_url"]);
      expect(catalog.matched).toBe(catalog.total - 2);
      const lines = formatAdoptionReport(report, true);
      expect(lines).toEqual(
        expect.arrayContaining([
          "         missing: label PaymentStatus.PARTIAL",
          "         missing: column events.banner_url",
          "Adoption aborted; nothing was written.",
        ]),
      );
      expect(report.written).toEqual({ migrations: 0, steps: 0 });
      expect(await migrationLedgerExists(database.client)).toBe(false);
    });
  });

  // The verifier's reproduction: 0000 built by the runner, 0001 and 0007-0009
  // run as raw SQL, the 43 foreign keys renamed to Prisma's names, and main's
  // real _prisma_migrations. Before the aliases this aborted with
  // "0000 ABORT probes 138/181 (partial)".
  describe("the verifier's reproduction (runner-built 0000, Prisma foreign key names)", () => {
    let database: ScratchDatabase;
    beforeAll(async () => {
      database = await createScratchDatabase({ label: "legacy_verifier", to: "0000" });
      databases.push(database);
      migrations = await loadMigrations(defaultMigrationsDirectory(), database.engine);
      for (const table of ["schema_migration_steps", "schema_migrations", "schema_migration_lock"]) {
        await database.client.query(`DROP TABLE public.${table}`);
      }
      for (const id of ["0001", "0007", "0008", "0009"]) {
        for (const statement of migrations.find((migration) => migration.id === id)!.statements) {
          await database.client.query(statement);
        }
      }
      for (const probe of deriveCatalogProbes(migrations[0]!)) {
        if ("query" in probe || probe.kind !== "constraint" || !probe.aliases) continue;
        await database.client.query(`ALTER TABLE "${probe.table}" RENAME CONSTRAINT "${probe.name}" TO "${probe.aliases[0]}"`);
      }
      await writeLegacyPrismaLedger(database.client);
    }, dbTestSetupTimeoutMs());

    it("now records 0000 as baseline", async () => {
      const keys = await database.client.query<{ constraint_name: string }>(
        `SELECT constraint_name FROM information_schema.table_constraints
         WHERE constraint_schema = 'public' AND constraint_type = 'FOREIGN KEY' AND constraint_name LIKE '%\\_fk'`,
      );
      expect(keys.rows).toEqual([]);

      const report = await adopt(database, false);
      expect(report.errors).toEqual([]);
      expect(formatAdoptionReport(report, false)[1]).toBe(
        `  0000 baseline [shared] probes 649/649 (all); _prisma_migrations 31 finished (latest ${PRISMA_EVIDENCE.latest})`,
      );
      const verdicts = classifications(report);
      // As on the full legacy schema, except 0010: the runner made timestamp(3) check-in columns, so it stays pending.
      expect(verdicts).toEqual({ ...expectedVerdicts(migrations), "0010": "pending" });
    });
  });
});
