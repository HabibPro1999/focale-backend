import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import type { ScratchDatabase } from "@app/db/testing";
import { createScratchDatabase } from "@app/db/testing";
import {
  LEGACY_NETWORKING_0018_CROSSWALK,
  applyMigrations,
  defaultMigrationsDirectory,
  legacyTracking,
  listMigrationRecords,
  listMigrationStepRecords,
  loadMigrations,
  migrationAdoptionSupport,
  migrationAdoptionWorkflow,
  migrationLedgerExists,
  refreshMigrationLease,
  verifyMigrations,
  type MigrationAdoptionReport,
  type MigrationDefinition,
} from "../../src/migrator";
import { assertSchemaCurrent, type SchemaCheckLogger } from "../../src/schema-check";
import { dbTestsEnabled } from "../helpers/test-env";
import { dbTestSetupTimeoutMs } from "../../vitest.shared";

// Adoption fixtures. Each database is built by the unified runner, then its
// ledger is removed and the legacy evidence an existing production database
// carries is written by hand: `networking_migrations` rows exactly as the old
// migrate-networking.mjs recorded them (file checksums; CockroachDB 0018 step
// rows) and a Prisma `_prisma_migrations` table.

const LEDGER_TABLES = ["schema_migration_steps", "schema_migrations", "schema_migration_lock"];

async function dropUnifiedLedger(client: Client): Promise<void> {
  for (const table of LEDGER_TABLES) await client.query(`DROP TABLE IF EXISTS public.${table}`);
}

async function writeOldScriptLedger(
  client: Client,
  migrations: MigrationDefinition[],
  options: { through: string; extra?: string[] },
): Promise<void> {
  await client.query(
    "CREATE TABLE IF NOT EXISTS networking_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const recorded = migrations.filter(
    (migration) => migration.id <= options.through || options.extra?.includes(migration.id),
  );
  for (const migration of recorded) {
    const tracking = legacyTracking(migration);
    if (!tracking) continue;
    if (migration.variant === "cockroach" && migration.id === LEGACY_NETWORKING_0018_CROSSWALK.id) {
      // The old runner split the shared 0018 file into guarded steps on CockroachDB.
      for (const [index, step] of LEGACY_NETWORKING_0018_CROSSWALK.steps.entries()) {
        await client.query("INSERT INTO networking_migrations(name,checksum) VALUES ($1,$2)", [
          `${tracking.name}:step:${index}`,
          step.legacyChecksum,
        ]);
      }
    }
    await client.query("INSERT INTO networking_migrations(name,checksum) VALUES ($1,$2)", [
      tracking.name,
      tracking.checksum,
    ]);
  }
}

async function writePrismaLedger(client: Client): Promise<void> {
  // Prisma's own migration table shape (legacy src/ app).
  await client.query(`
    CREATE TABLE "_prisma_migrations" (
      id varchar(36) PRIMARY KEY,
      checksum varchar(64) NOT NULL,
      finished_at timestamptz,
      migration_name varchar(255) NOT NULL,
      logs text,
      rolled_back_at timestamptz,
      started_at timestamptz NOT NULL DEFAULT now(),
      applied_steps_count integer NOT NULL DEFAULT 0
    )`);
  const names = ["20250101000000_init", "20260301000000_abstracts", "20260514000000_tshg_abstract_requirements"];
  for (const [index, name] of names.entries()) {
    await client.query(
      `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, applied_steps_count)
       VALUES ($1, $2, now(), $3, 1)`,
      [`00000000-0000-0000-0000-00000000000${index}`, String(index).repeat(64), name],
    );
  }
}

function classifications(report: MigrationAdoptionReport): Record<string, string> {
  return Object.fromEntries(
    report.assessments.map((assessment) => [assessment.migration.id, assessment.abort ? "ABORT" : assessment.classification!]),
  );
}

const silent: SchemaCheckLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Run the boot check against a fresh UTC-pinned session on the scratch DB. */
async function bootCheck(url: string) {
  const session = new Client({ connectionString: url, options: "-c TimeZone=UTC" });
  await session.connect();
  return assertSchemaCurrent({
    mode: "enforce",
    logger: silent,
    connect: async () => ({
      query: session.query.bind(session),
      release: () => void session.end(),
    }) as never,
  });
}

describe.runIf(dbTestsEnabled())("migrate adopt on existing databases", () => {
  let migrations: MigrationDefinition[];
  const databases: ScratchDatabase[] = [];

  async function scratch(label: string, to?: string): Promise<ScratchDatabase> {
    const database = await createScratchDatabase({ label, ...(to ? { to } : {}) });
    databases.push(database);
    migrations = await loadMigrations(defaultMigrationsDirectory(), database.engine);
    await dropUnifiedLedger(database.client);
    return database;
  }

  function adopt(database: ScratchDatabase, writeLedger: boolean): Promise<MigrationAdoptionReport> {
    return migrationAdoptionWorkflow.run(
      database.client,
      database.engine,
      migrations,
      { writeLedger, appliedBy: "adopt-test", leaseConnectionString: database.url },
      migrationAdoptionSupport,
    );
  }

  afterAll(async () => {
    for (const database of databases) await database.close().catch(() => undefined);
  }, dbTestSetupTimeoutMs());

  describe("old-script database (0012+ recorded by migrate-networking.mjs)", () => {
    let database: ScratchDatabase;
    beforeAll(async () => {
      database = await scratch("adopt_old_script");
      await writeOldScriptLedger(database.client, migrations, { through: "0019" });
    }, dbTestSetupTimeoutMs());

    it("classifies every migration from the legacy ledger and probes, writing nothing on a dry run", async () => {
      const report = await adopt(database, false);
      expect(report.errors).toEqual([]);
      expect(report.aborted).toBe(false);
      const expected = Object.fromEntries(migrations.map((migration) => [migration.id, "applied"]));
      // 0011 is a guarded data repair with no catalog probe: apply re-runs it (idempotent).
      expected["0011"] = "pending";
      expect(classifications(report)).toEqual(expected);
      expect(report.written).toEqual({ migrations: 0, steps: 0 });
      expect(await migrationLedgerExists(database.client)).toBe(false);

      // 0018 dropped the per-event index 0012 created; 0012 is judged without it.
      const networking = report.assessments.find((assessment) => assessment.migration.id === "0012")!;
      expect(networking.evidence.catalog).toMatchObject({
        state: "all",
        superseded: ["index networking_tables.networking_tables_event_name_key (declared again by 0018)"],
      });
      expect(networking.evidence.legacyNetworking).toMatchObject({ name: "0012_networking.sql", recorded: true });
    });

    it("--apply writes ledger rows only; apply then runs just the unproven migration", async () => {
      const tablesBefore = (await database.client.query("SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public'")).rows[0].n;
      const report = await adopt(database, true);
      expect(report.aborted).toBe(false);
      const steps = database.engine === "cockroach" ? LEGACY_NETWORKING_0018_CROSSWALK.steps.length : 0;
      expect(report.written).toEqual({ migrations: migrations.length - 1, steps });
      // Only the three ledger tables were added.
      const tablesAfter = (await database.client.query("SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public'")).rows[0].n;
      expect(Number(tablesAfter) - Number(tablesBefore)).toBe(3);

      const records = await listMigrationRecords(database.client);
      expect(records.map((record) => record.id)).toEqual(migrations.map((m) => m.id).filter((id) => id !== "0011"));
      expect(new Set(records.map((record) => record.status))).toEqual(new Set(["applied"]));
      expect(records.find((record) => record.id === "0015")?.applied_by).toBe("adopt-test");
      if (database.engine === "cockroach") {
        const stepRows = await listMigrationStepRecords(database.client, "0018", "cockroach");
        expect(stepRows.map((row) => row.checksum)).toEqual(
          LEGACY_NETWORKING_0018_CROSSWALK.steps.map((step) => step.variantChecksum),
        );
      }

      const result = await applyMigrations(database.client, migrations, { appliedBy: "adopt-test" });
      expect(result.applied).toEqual(["0011"]);
      const verification = await verifyMigrations(database.client, database.engine, migrations, { schema: true });
      expect(verification.errors).toEqual([]);
      expect((await bootCheck(database.url)).errors).toEqual([]);
    }, dbTestSetupTimeoutMs());

    it("refuses to adopt a database that already has a ledger", async () => {
      const report = await adopt(database, true);
      expect(report.aborted).toBe(true);
      expect(report.errors[0]).toMatch(/schema_migrations already has \d+ row/);
      expect(report.written).toEqual({ migrations: 0, steps: 0 });
    });
  });

  describe("Prisma-shaped database (0000 only, _prisma_migrations present)", () => {
    let database: ScratchDatabase;
    beforeAll(async () => {
      database = await scratch("adopt_prisma", "0000");
      await writePrismaLedger(database.client);
    }, dbTestSetupTimeoutMs());

    it("records 0000 as baseline and leaves later migrations pending for apply", async () => {
      const report = await adopt(database, true);
      expect(report.errors).toEqual([]);
      const verdicts = classifications(report);
      expect(verdicts["0000"]).toBe("baseline");
      expect(report.assessments[0]!.evidence.prisma).toMatchObject({
        finished: 3,
        latest: "20260514000000_tshg_abstract_requirements",
      });
      // 0002 only drops an index Prisma had already removed, so it is already in effect.
      expect(verdicts["0002"]).toBe("applied");
      const pending = Object.entries(verdicts).filter(([, verdict]) => verdict === "pending").map(([id]) => id);
      expect(pending).toEqual(migrations.map((m) => m.id).filter((id) => id !== "0000" && id !== "0002"));
      expect(report.written).toEqual({ migrations: 2, steps: 0 });

      const records = await listMigrationRecords(database.client);
      expect(records.map((record) => [record.id, record.status])).toEqual([
        ["0000", "baseline"],
        ["0002", "applied"],
      ]);

      const result = await applyMigrations(database.client, migrations, { appliedBy: "adopt-test" });
      expect(result.applied).toEqual(pending);
      expect((await verifyMigrations(database.client, database.engine, migrations, { schema: true })).errors).toEqual([]);
    }, dbTestSetupTimeoutMs());
  });

  describe("partial or contradictory evidence", () => {
    let database: ScratchDatabase;
    beforeAll(async () => {
      database = await scratch("adopt_partial", "0015");
    }, dbTestSetupTimeoutMs());

    it("aborts when the legacy ledger records a migration whose objects are missing", async () => {
      // 0016 never ran, yet the old ledger claims it did.
      await writeOldScriptLedger(database.client, migrations, { through: "0015", extra: ["0016"] });
      const report = await adopt(database, true);
      expect(report.aborted).toBe(true);
      expect(report.errors).toEqual([
        "0016: networking_migrations records 0016_networking_read_indexes.sql as applied, but its catalog probes do not all match",
      ]);
      expect(report.written).toEqual({ migrations: 0, steps: 0 });
      expect(await migrationLedgerExists(database.client)).toBe(false);
      await database.client.query("DROP TABLE networking_migrations");
    });

    it("aborts on a partially present non-idempotent migration and writes nothing", async () => {
      await database.client.query("DROP TABLE networking_second_factors");
      const report = await adopt(database, true);
      expect(report.aborted).toBe(true);
      expect(report.errors).toEqual(["0015: catalog probes partially match a non-idempotent migration"]);
      const assessment = report.assessments.find((candidate) => candidate.migration.id === "0015")!;
      expect(assessment.evidence.catalog).toMatchObject({ state: "partial", matched: 1, total: 2, failed: ["table networking_second_factors"] });
      expect(report.written).toEqual({ migrations: 0, steps: 0 });
      expect(await migrationLedgerExists(database.client)).toBe(false);
      // apply still refuses the unadopted, non-empty schema.
      await expect(applyMigrations(database.client, migrations, { appliedBy: "adopt-test" })).rejects.toThrow(/run migrate adopt first/);
    });
  });

  describe("lease renewal during the ledger write", () => {
    let database: ScratchDatabase;
    beforeAll(async () => {
      database = await scratch("adopt_lease_race");
      await writeOldScriptLedger(database.client, migrations, { through: "0019" });
    }, dbTestSetupTimeoutMs());

    it("writes the ledger again when a heartbeat renewal commits inside its transaction", async () => {
      const other = new Client({ connectionString: database.url });
      await other.connect();
      let renewed = false;
      let writes = 0;
      const support: typeof migrationAdoptionSupport = {
        ...migrationAdoptionSupport,
        ledger: {
          ...migrationAdoptionSupport.ledger,
          async writeMigration(...args: Parameters<typeof migrationAdoptionSupport.ledger.writeMigration>) {
            writes += 1;
            if (!renewed) {
              renewed = true;
              // What the heartbeat does every 30 s, landing while the ledger transaction is open.
              const lock = await other.query<{ owner: string }>("SELECT owner FROM public.schema_migration_lock WHERE id = 1");
              await refreshMigrationLease(other, lock.rows[0]!.owner);
            }
            return migrationAdoptionSupport.ledger.writeMigration(...args);
          },
        },
      };
      try {
        const report = await migrationAdoptionWorkflow.run(
          database.client,
          database.engine,
          migrations,
          { writeLedger: true, appliedBy: "adopt-test", leaseConnectionString: database.url },
          support,
        );
        expect(report.errors).toEqual([]);
        const adopted = migrations.length - 1; // all but 0011
        expect(report.written.migrations).toBe(adopted);
        expect((await listMigrationRecords(database.client)).length).toBe(adopted);
        // CockroachDB rejects the first commit at the lease fence (40001); the whole transaction is written again.
        expect(writes).toBe(database.engine === "cockroach" ? 2 * adopted : adopted);
      } finally {
        await other.end();
      }
    }, dbTestSetupTimeoutMs());
  });

  describe("populated embeddings (old script stopped before the CockroachDB vector index)", () => {
    let database: ScratchDatabase;
    beforeAll(async () => {
      database = await scratch("adopt_embeddings", "0016");
      await database.client.query(`
        INSERT INTO clients(id,name,updated_at) VALUES ('client','QA',now());
        INSERT INTO events(id,client_id,name,slug,start_date,end_date,updated_at) VALUES ('event','client','QA','qa',now(),now()+interval '2 days',now());
        INSERT INTO forms(id,event_id,name,schema,updated_at) VALUES ('form','event','QA','{}',now());
        INSERT INTO registrations(id,form_id,event_id,form_data,email,total_amount,price_breakdown,updated_at) VALUES
          ('registration','form','event','{}','guest@example.invalid',0,'{}',now());
        INSERT INTO networking_profiles(id,event_id,registration_id,email,first_name,updated_at) VALUES
          ('profile','event','registration','guest@example.invalid','Guest',now());
        INSERT INTO networking_tables(id,event_id,name,kind,capacity,updated_at) VALUES ('table','event','Table','TABLE',8,now());
      `);
      await database.client.query(
        `INSERT INTO networking_embeddings(id,profile_id,event_id,kind,model,source_hash,embedding)
         VALUES ('embedding','profile','event','PROFILE','test-model','hash',$1::vector)`,
        [`[${Array.from({ length: 1536 }, () => "0.1").join(",")}]`],
      );
      await writeOldScriptLedger(database.client, migrations, { through: "0016" });
    }, dbTestSetupTimeoutMs());

    it("adopts through 0016, then apply defers 0017 and still applies 0018/0019", async () => {
      const report = await adopt(database, true);
      expect(report.errors).toEqual([]);
      const verdicts = classifications(report);
      const tail = migrations.map((migration) => migration.id).filter((id) => id > "0016");
      expect(tail.slice(0, database.engine === "cockroach" ? 3 : 2)).toEqual(
        database.engine === "cockroach" ? ["0017", "0018", "0019"] : ["0018", "0019"],
      );
      for (const id of tail) expect(verdicts[id]).toBe("pending");
      expect(verdicts["0016"]).toBe("applied");
      if (database.engine === "cockroach") {
        expect(report.warnings).toContain("0017 is deferrable; apply evaluates its defer-unless condition");
      }

      const result = await applyMigrations(database.client, migrations, { appliedBy: "adopt-test" });
      expect(result.applied).toEqual(["0011", ...tail.filter((id) => id !== "0017")]);
      expect(result.deferred).toEqual(database.engine === "cockroach" ? ["0017"] : []);

      const verification = await verifyMigrations(database.client, database.engine, migrations, { schema: true });
      expect(verification.errors).toEqual([]);
      const check = await bootCheck(database.url);
      expect(check.errors).toEqual([]);
      expect(check.warnings).toEqual(database.engine === "cockroach" ? ["Migration 0017 is deferred"] : []);
      expect(Number((await database.client.query("SELECT count(*) AS n FROM networking_embeddings")).rows[0].n)).toBe(1);
      // The legacy table of the old runner is left in place for the operator.
      expect(Number((await database.client.query("SELECT count(*) AS n FROM networking_migrations")).rows[0].n)).toBeGreaterThan(0);
    }, dbTestSetupTimeoutMs());
  });
});
