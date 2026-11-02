import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScratchDatabase } from "@app/db/testing";
import { createScratchDatabase, dbTestsEnabled } from "@app/db/testing";
import {
  applyMigrations,
  defaultMigrationsDirectory,
  listMigrationRecords,
  listMigrationStepRecords,
  loadMigrations,
  migrationChecksum,
  parseMigrationDirectives,
  splitMigrationStatements,
  type MigrationDefinition,
  type SchemaMigrationRecord,
} from "../../src/migrator";
import { dbTestSetupTimeoutMs } from "../../../vitest.shared";

// A unique index build that meets duplicate rows must leave its migration
// unrecorded, so the next apply builds it, never "applied" with no index.
// PostgreSQL, and CockroachDB with autocommit_before_ddl on (the 26.2
// default), fail the statement itself and its transaction rolls back. With
// autocommit_before_ddl off, CockroachDB builds the index after COMMIT on a
// table that is not schema_locked (26.2 locks new tables by default; tables
// created before that default are not): the transaction commits, ledger rows
// included, the index is rolled back, and COMMIT fails with XXA00. The runner
// then removes those ledger rows. On CockroachDB, every case from the second
// one on runs in that mode.

function synthetic(id: string, name: string, source: string): MigrationDefinition {
  const file = `${id}_${name}.sql`;
  return {
    id,
    name: file,
    variant: "shared",
    filePath: `synthetic/${file}`,
    source,
    checksum: migrationChecksum(source),
    directives: parseMigrationDirectives(source, file),
    statements: splitMigrationStatements(source),
  };
}

// Synthetic files skip the directory lint; they index a table the suite
// creates with duplicate keys. 9101 is a deferred per-file migration that
// --apply-deferred retries; 9102 runs a data step, then the index step.
const DEFERRED_INDEX = synthetic("9101", "abort_deferred_index", [
  "-- migrate: transaction per-file",
  "-- migrate: idempotent",
  "-- migrate: deferrable",
  '-- migrate: defer-unless "SELECT false"',
  "CREATE UNIQUE INDEX IF NOT EXISTS schema_change_abort_probe_a_key ON schema_change_abort_probe (a);",
].join("\n"));
const STEPPED_INDEX = synthetic("9102", "abort_stepped_index", [
  "-- migrate: transaction per-statement",
  "-- migrate: idempotent",
  "UPDATE schema_change_abort_probe SET touched = true WHERE NOT touched;",
  "--> statement-breakpoint",
  "CREATE UNIQUE INDEX IF NOT EXISTS schema_change_abort_probe_b_key ON schema_change_abort_probe (b);",
].join("\n"));

const ACTIVE_JOB_INDEX = "abstract_book_jobs_event_id_active_key";

describe.runIf(dbTestsEnabled())("migration tier: a unique index that fails on duplicates is never recorded as applied", () => {
  let scratch: ScratchDatabase;
  let migrations: MigrationDefinition[];

  beforeAll(async () => {
    scratch = await createScratchDatabase({ label: "schema_change_abort", to: "0003" });
    await scratch.client.query(`
      INSERT INTO clients (id, name, updated_at) VALUES ('cl1', 'Client', now());
      INSERT INTO events (id, client_id, name, slug, start_date, end_date, updated_at)
      VALUES ('ev1', 'cl1', 'Event', 'event', now(), now(), now());
      INSERT INTO abstract_book_jobs (id, event_id, requested_by, status, updated_at)
      VALUES ('job-1', 'ev1', 'user-1', 'PENDING', now()), ('job-2', 'ev1', 'user-2', 'RUNNING', now());
    `);
    await scratch.client.query(
      "CREATE TABLE schema_change_abort_probe (id integer PRIMARY KEY, a integer NOT NULL, b integer NOT NULL, touched boolean NOT NULL DEFAULT false)",
    );
    await scratch.client.query("INSERT INTO schema_change_abort_probe (id, a, b) VALUES (1, 1, 1), (2, 1, 1)");
    const shipped = await loadMigrations(defaultMigrationsDirectory(), scratch.engine, { through: "0004" });
    migrations = [...shipped, DEFERRED_INDEX, STEPPED_INDEX];
  }, dbTestSetupTimeoutMs());

  afterAll(async () => scratch?.close(), dbTestSetupTimeoutMs());

  /** CockroachDB: build schema changes at COMMIT, as on a cluster with autocommit_before_ddl off. */
  async function buildSchemaChangesAtCommit(...tables: string[]): Promise<void> {
    if (scratch.engine !== "cockroach") return;
    for (const table of tables) await scratch.client.query(`ALTER TABLE ${table} SET (schema_locked = false)`);
    await scratch.client.query("SET autocommit_before_ddl = off");
  }

  function apply(through: string, applyDeferred?: string) {
    return applyMigrations(scratch.client, migrations, {
      through,
      applyDeferred,
      appliedBy: "schema-change-abort-test",
      leaseConnectionString: scratch.url,
    });
  }

  /** The SQLSTATE of a failed index build once CockroachDB builds at COMMIT. */
  function failedBuildAtCommit(): { code: string } {
    return { code: scratch.engine === "cockroach" ? "XXA00" : "23505" };
  }

  async function record(id: string): Promise<SchemaMigrationRecord | undefined> {
    return (await listMigrationRecords(scratch.client)).find((entry) => entry.id === id);
  }

  async function steps(id: string): Promise<number[]> {
    return (await listMigrationStepRecords(scratch.client, id, "shared")).map((entry) => entry.step_index);
  }

  async function indexExists(table: string, name: string): Promise<boolean> {
    const { rows } = await scratch.client.query(
      "SELECT 1 FROM pg_catalog.pg_indexes WHERE schemaname = 'public' AND tablename = $1 AND indexname = $2",
      [table, name],
    );
    return rows.length === 1;
  }

  it("0004 fails at its statement in the default session and records nothing", async () => {
    await expect(apply("0004")).rejects.toMatchObject({ code: "23505" });
    expect(await record("0004")).toBeUndefined();
    expect(await steps("0004")).toEqual([]);
    expect(await indexExists("abstract_book_jobs", ACTIVE_JOB_INDEX)).toBe(false);
  });

  it("0004 is not recorded when CockroachDB rolls its index back after COMMIT", async ({ skip }) => {
    if (scratch.engine !== "cockroach") skip();
    await buildSchemaChangesAtCommit("abstract_book_jobs", "schema_change_abort_probe");
    const failure = await apply("0004").catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "XXA00", message: expect.stringMatching(/^Migration 0004 was not applied/) });
    expect(await record("0004")).toBeUndefined();
    expect(await steps("0004")).toEqual([]);
    expect(await indexExists("abstract_book_jobs", ACTIVE_JOB_INDEX)).toBe(false);
  });

  it("applies 0004 once the duplicate active job is resolved", async () => {
    await scratch.client.query("UPDATE abstract_book_jobs SET status = 'FAILED' WHERE id = 'job-2'");
    const result = await apply("0004");
    expect(result.applied).toEqual(["0004"]);
    expect((await record("0004"))?.status).toBe("applied");
    expect(await steps("0004")).toEqual([0]);
    expect(await indexExists("abstract_book_jobs", ACTIVE_JOB_INDEX)).toBe(true);
  });

  it("keeps a per-file migration deferred, with its record unchanged, when --apply-deferred fails", async () => {
    await buildSchemaChangesAtCommit("schema_change_abort_probe");
    expect((await apply("9101")).deferred).toEqual(["9101"]);
    const deferred = await record("9101");
    expect(deferred?.status).toBe("deferred");

    await expect(apply("9101", "9101")).rejects.toMatchObject(failedBuildAtCommit());
    const after = await record("9101");
    expect(after).toMatchObject({
      status: "deferred",
      applied_by: deferred!.applied_by,
      evidence: deferred!.evidence,
    });
    expect(new Date(after!.applied_at).getTime()).toBe(new Date(deferred!.applied_at).getTime());
    expect(await steps("9101")).toEqual([]);
    expect(await indexExists("schema_change_abort_probe", "schema_change_abort_probe_a_key")).toBe(false);
  });

  it("records only the committed data step of a per-statement migration whose index fails", async () => {
    await buildSchemaChangesAtCommit("schema_change_abort_probe");
    await expect(apply("9102")).rejects.toMatchObject(failedBuildAtCommit());
    expect(await record("9102")).toBeUndefined();
    expect(await steps("9102")).toEqual([0]);
    expect(await indexExists("schema_change_abort_probe", "schema_change_abort_probe_b_key")).toBe(false);

    // A rerun resumes at the index step and fails the same way: never "applied".
    await expect(apply("9102")).rejects.toMatchObject(failedBuildAtCommit());
    expect(await record("9102")).toBeUndefined();
    expect(await steps("9102")).toEqual([0]);
  });

  it("applies both once the duplicates are resolved", async () => {
    await scratch.client.query("UPDATE schema_change_abort_probe SET a = 2, b = 2 WHERE id = 2");
    const result = await apply("9102");
    expect(result.applied).toEqual(["9102"]);
    expect(result.deferred).toEqual(["9101"]);
    expect(await steps("9102")).toEqual([0, 1]);
    expect(await indexExists("schema_change_abort_probe", "schema_change_abort_probe_b_key")).toBe(true);

    expect((await apply("9102", "9101")).applied).toEqual(["9101"]);
    expect((await record("9101"))?.status).toBe("applied");
    expect(await indexExists("schema_change_abort_probe", "schema_change_abort_probe_a_key")).toBe(true);
  });
});
