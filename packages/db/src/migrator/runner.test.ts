import type { Client } from "pg";
import { describe, expect, it } from "vitest";
import {
  LEASE_FENCED_TRANSACTION_ATTEMPTS,
  applyMigrations,
  listMigrationStepRecords,
  runLeaseFencedTransaction,
} from "./runner";
import type { MigrationDefinition } from "./migration";
import type { SchemaMigrationRecord } from "./types";

describe("migration step ledger decoding", () => {
  it("normalizes CockroachDB INT8 step indexes to numbers", async () => {
    const client = {
      async query() {
        return {
          rows: [{
            migration_id: "0018",
            variant: "cockroach",
            step_index: "4",
            checksum: "a".repeat(64),
            applied_at: new Date("2026-09-23T00:00:00.000Z"),
            applied_by: "migrator-test",
          }],
        };
      },
    } as unknown as Client;

    await expect(listMigrationStepRecords(client, "0018", "cockroach")).resolves.toEqual([
      expect.objectContaining({ step_index: 4 }),
    ]);
  });

  it("rejects unsafe step indexes returned by the database", async () => {
    const client = {
      async query() {
        return {
          rows: [{
            migration_id: "0018",
            variant: "cockroach",
            step_index: "9007199254740992",
            checksum: "a".repeat(64),
            applied_at: new Date("2026-09-23T00:00:00.000Z"),
            applied_by: "migrator-test",
          }],
        };
      },
    } as unknown as Client;

    await expect(listMigrationStepRecords(client, "0018", "cockroach")).rejects.toThrow(/invalid recorded step index/);
  });
});

describe("migration dry-run preconditions", () => {
  it("reports a planned Cockroach precondition as unknown when an earlier pending migration creates its relation", async () => {
    const condition = "SELECT NOT EXISTS (SELECT 1 FROM networking_embeddings)";
    const migrations: MigrationDefinition[] = [
      {
        id: "0013",
        name: "0013_networking_embeddings.sql",
        variant: "shared",
        filePath: "0013_networking_embeddings.sql",
        source: "CREATE TABLE networking_embeddings (id text PRIMARY KEY);",
        checksum: "a".repeat(64),
        directives: { transaction: "per-file", requiresExtensions: [], idempotent: false, deferrable: false, verify: [] },
        statements: ["CREATE TABLE networking_embeddings (id text PRIMARY KEY);"],
      },
      {
        id: "0017",
        name: "0017_networking_vector_index.sql",
        variant: "cockroach",
        filePath: "cockroach/0017_networking_vector_index.sql",
        source: "CREATE VECTOR INDEX networking_embeddings_cosine_idx ON networking_embeddings(embedding);",
        checksum: "b".repeat(64),
        directives: { transaction: "per-file", requiresExtensions: [], idempotent: false, deferrable: true, deferUnless: condition, verify: [] },
        statements: ["CREATE VECTOR INDEX networking_embeddings_cosine_idx ON networking_embeddings(embedding);"],
      },
    ];
    const client = {
      async query(sql: string) {
        if (sql === "SET TIME ZONE 'UTC'") return { rows: [] };
        if (sql.includes("SELECT version()")) return { rows: [{ version: "CockroachDB CCL v26.2.5" }] };
        if (sql.includes("table_name NOT IN")) return { rows: [{ present: false }] };
        if (sql.includes("information_schema.tables")) return { rows: [{ present: false }] };
        if (sql === condition) {
          throw Object.assign(new Error('relation "networking_embeddings" does not exist'), { code: "42P01" });
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as Client;

    await expect(applyMigrations(client, migrations, { dryRun: true })).resolves.toEqual({
      engine: "cockroach",
      applied: ["0013"],
      deferred: [],
      skipped: [],
      unknownPreconditions: ["0017 (networking_embeddings will be created by pending 0013)"],
    });
  });

  it("lists applied migrations as skipped only during dry-run", async () => {
    const migration: MigrationDefinition = {
      id: "0013",
      name: "0013_networking_embeddings.sql",
      variant: "shared",
      filePath: "0013_networking_embeddings.sql",
      source: "CREATE TABLE networking_embeddings (id text PRIMARY KEY);",
      checksum: "a".repeat(64),
      directives: { transaction: "per-file", requiresExtensions: [], idempotent: false, deferrable: false, verify: [] },
      statements: ["CREATE TABLE networking_embeddings (id text PRIMARY KEY);"],
    };
    const record = {
      id: migration.id,
      variant: migration.variant,
      checksum: migration.checksum,
      status: "applied",
      applied_at: new Date(),
      applied_by: "migrator-test",
      evidence: {},
    };
    const client = {
      async query(sql: string) {
        if (sql === "SET TIME ZONE 'UTC'") return { rows: [] };
        if (sql.includes("SELECT version()")) return { rows: [{ version: "CockroachDB CCL v26.2.5" }] };
        if (sql.includes("table_name NOT IN")) return { rows: [{ present: true }] };
        if (sql.includes("information_schema.tables")) return { rows: [{ present: true }] };
        if (sql.includes("SELECT EXISTS (SELECT 1 FROM public.schema_migrations)")) return { rows: [{ present: true }] };
        if (sql.includes("FROM public.schema_migrations ORDER BY id")) return { rows: [record] };
        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as Client;

    await expect(applyMigrations(client, [migration], { dryRun: true })).resolves.toEqual({
      engine: "cockroach",
      applied: [],
      deferred: [],
      skipped: ["0013"],
      unknownPreconditions: [],
    });
  });
});

describe("lease-fenced transactions", () => {
  const serializationFailure = () =>
    Object.assign(new Error("restart transaction: WriteTooOldError"), { code: "40001" });

  /** A client whose lease fence fails with the given errors, in order, then succeeds. */
  function fencedClient(fenceFailures: Error[]) {
    const sent: string[] = [];
    const client = {
      async query(sql: string) {
        sent.push(sql.trim().split(/\s+/).slice(0, 2).join(" "));
        if (sql.includes("UPDATE public.schema_migration_lock")) {
          const failure = fenceFailures.shift();
          if (failure) throw failure;
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      },
    } as unknown as Client;
    return { client, sent };
  }

  it("runs the whole transaction again when the fence fails with 40001", async () => {
    const { client, sent } = fencedClient([serializationFailure()]);
    let runs = 0;
    await runLeaseFencedTransaction(client, "owner", undefined, async () => {
      runs += 1;
      await client.query("INSERT INTO work");
    });
    expect(runs).toBe(2);
    expect(sent).toEqual([
      "BEGIN", "INSERT INTO", "UPDATE public.schema_migration_lock", "ROLLBACK",
      "BEGIN", "INSERT INTO", "UPDATE public.schema_migration_lock", "COMMIT",
    ]);
  });

  it("rolls back and rethrows any other failure without running the work again", async () => {
    const lost = Object.assign(new Error("lease lost"), { code: "57014" });
    const { client, sent } = fencedClient([lost]);
    let runs = 0;
    await expect(runLeaseFencedTransaction(client, "owner", undefined, async () => {
      runs += 1;
    })).rejects.toBe(lost);
    expect(runs).toBe(1);
    expect(sent).toEqual(["BEGIN", "UPDATE public.schema_migration_lock", "ROLLBACK"]);
  });

  it("gives up after the bounded number of attempts", async () => {
    const failures = Array.from({ length: LEASE_FENCED_TRANSACTION_ATTEMPTS }, serializationFailure);
    const last = failures.at(-1);
    const { client, sent } = fencedClient(failures);
    let runs = 0;
    await expect(runLeaseFencedTransaction(client, "owner", undefined, async () => {
      runs += 1;
    })).rejects.toBe(last);
    expect(runs).toBe(LEASE_FENCED_TRANSACTION_ATTEMPTS);
    expect(sent.filter((sql) => sql === "COMMIT")).toEqual([]);
    expect(sent.filter((sql) => sql === "ROLLBACK")).toHaveLength(LEASE_FENCED_TRANSACTION_ATTEMPTS);
  });

  it("commits a non-transactional statement once and retries only its ledger writes", async () => {
    const migration: MigrationDefinition = {
      id: "9003",
      name: "9003_backfill.sql",
      variant: "shared",
      filePath: "9003_backfill.sql",
      source: "-- migrate: transaction none\nUPDATE things SET flag = true;",
      checksum: "c".repeat(64),
      directives: { transaction: "none", requiresExtensions: [], idempotent: true, deferrable: false, verify: [] },
      statements: ["UPDATE things SET flag = true;"],
    };
    const sent: string[] = [];
    let owner = "";
    let pendingWrite: string | undefined;
    const rejected = new Set<string>();
    const client = {
      async query(sql: string, values?: unknown[]) {
        sent.push(sql);
        if (sql === "SET TIME ZONE 'UTC'") return { rows: [] };
        if (sql.includes("SELECT version()")) return { rows: [{ version: "PostgreSQL 16.4" }] };
        if (sql.includes("table_name NOT IN")) return { rows: [{ present: false }] };
        if (sql.includes("information_schema.tables")) return { rows: [{ present: true }] };
        if (sql.includes("SET owner = $1")) owner = String(values?.[0]);
        if (sql.includes("SELECT owner")) return { rows: [{ owner, active: true }] };
        if (sql.startsWith("SELECT")) return { rows: [] };
        if (/^\s*INSERT INTO public\.schema_migration(s|_steps)\b/.test(sql)) pendingWrite = sql;
        if (sql.includes("SET lease_until") && pendingWrite) {
          // The first fence of each ledger write is rejected, as after a heartbeat renewal on CockroachDB.
          const write = pendingWrite;
          pendingWrite = undefined;
          if (!rejected.has(write)) {
            rejected.add(write);
            throw serializationFailure();
          }
        }
        return { rowCount: 1, rows: [] };
      },
    } as unknown as Client;

    await expect(applyMigrations(client, [migration])).resolves.toMatchObject({ applied: ["9003"] });
    expect(sent.filter((sql) => sql === migration.statements[0])).toHaveLength(1);
    expect(sent.filter((sql) => sql.includes("INSERT INTO public.schema_migration_steps"))).toHaveLength(2);
    expect(sent.filter((sql) => sql.includes("INSERT INTO public.schema_migrations"))).toHaveLength(2);
    expect(sent.filter((sql) => sql === "COMMIT")).toHaveLength(2);
  });
});

describe("schema changes rolled back after COMMIT (CockroachDB XXA00)", () => {
  const INDEX = "CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_key ON jobs (event_id) WHERE status = 'PENDING'";
  const NORMALIZE = "UPDATE jobs SET status = 'PENDING' WHERE status = 'pending'";

  function definition(
    id: string,
    transaction: "per-file" | "per-statement",
    statements: string[],
    deferUnless?: string,
  ): MigrationDefinition {
    return {
      id,
      name: `${id}_jobs_active_unique.sql`,
      variant: "shared",
      filePath: `${id}_jobs_active_unique.sql`,
      source: statements.join("\n--> statement-breakpoint\n"),
      checksum: id.repeat(16),
      directives: {
        transaction,
        requiresExtensions: [],
        idempotent: true,
        deferrable: Boolean(deferUnless),
        ...(deferUnless ? { deferUnless } : {}),
        verify: [],
      },
      statements,
    };
  }

  /**
   * A CockroachDB client whose ledger holds `records`. The transaction that runs
   * `failing` fails as `failure` says: "commit" answers its COMMIT with XXA00
   * (committed, schema change rolled back); "statement" fails the statement
   * itself, as PostgreSQL does and CockroachDB with autocommit_before_ddl on.
   * Lease reads succeed; SELECTs are left out of `sent`.
   */
  function abortingClient(
    failing: string,
    failure: "commit" | "statement",
    records: SchemaMigrationRecord[] = [],
    options: { cleanupFails?: boolean } = {},
  ) {
    const sent: Array<{ sql: string; values?: unknown[] }> = [];
    let owner = "";
    let failCommit = false;
    const client = {
      async query(sql: string, values?: unknown[]) {
        if (sql === "SET TIME ZONE 'UTC'") return { rows: [] };
        if (sql.includes("SELECT version()")) return { rows: [{ version: "CockroachDB CCL v26.2.5" }] };
        if (sql.includes("table_name NOT IN")) return { rows: [{ present: true }] };
        if (sql.includes("information_schema.tables")) return { rows: [{ present: true }] };
        if (sql.includes("SELECT EXISTS (SELECT 1 FROM public.schema_migrations)")) return { rows: [{ present: true }] };
        if (sql.includes("FROM public.schema_migrations ORDER BY id")) return { rows: records };
        if (sql.includes("SET owner = $1")) owner = String(values?.[0]);
        if (sql.includes("SELECT owner")) return { rows: [{ owner, active: true }] };
        if (sql.trim().startsWith("SELECT")) return { rows: [] };
        sent.push({ sql: sql.trim().split(/\s+/).slice(0, 3).join(" ").replace(/ SET$/, ""), values });
        if (sql === failing && failure === "statement") {
          throw Object.assign(new Error('duplicate key value violates unique constraint "jobs_active_key"'), { code: "23505" });
        }
        if (sql === failing) failCommit = true;
        if (sql === "COMMIT" && failCommit) {
          failCommit = false;
          throw Object.assign(
            new Error('transaction committed but schema change aborted with error: (23505): duplicate key value violates unique constraint "jobs_active_key"'),
            { code: "XXA00" },
          );
        }
        if (sql.trim().startsWith("DELETE") && options.cleanupFails) throw new Error("connection terminated");
        return { rowCount: 1, rows: [] };
      },
    } as unknown as Client;
    const after = (statement: string) => sent.slice(sent.findIndex((entry) => entry.sql === statement)).map((entry) => entry.sql);
    return { client, sent, after };
  }

  it("removes the step and migration rows a per-file transaction committed, then fails", async () => {
    const migration = definition("9001", "per-file", [INDEX]);
    const { client, sent, after } = abortingClient(INDEX, "commit");

    const failure = await applyMigrations(client, [migration]).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "XXA00", message: expect.stringMatching(/^Migration 9001 was not applied: .*Its ledger rows were removed/) });
    expect((failure as Error).cause).toMatchObject({ code: "XXA00" });
    expect(after("CREATE UNIQUE INDEX")).toEqual([
      "CREATE UNIQUE INDEX",
      "INSERT INTO public.schema_migration_steps",
      "INSERT INTO public.schema_migrations",
      "UPDATE public.schema_migration_lock",
      "COMMIT",
      "ROLLBACK",
      // A new lease-fenced transaction removes what the committed one wrote.
      "BEGIN",
      "DELETE FROM public.schema_migration_steps",
      "DELETE FROM public.schema_migrations",
      "UPDATE public.schema_migration_lock",
      "COMMIT",
      // Lease release.
      "UPDATE public.schema_migration_lock",
    ]);
    expect(sent.find((entry) => entry.sql === "DELETE FROM public.schema_migration_steps")?.values?.slice(0, 3)).toEqual(["9001", "shared", 0]);
    expect(sent.find((entry) => entry.sql === "DELETE FROM public.schema_migrations")?.values).toEqual(["9001", "shared", migration.checksum]);
  });

  it("puts back the deferred record a per-file --apply-deferred replaced", async () => {
    const migration = definition("9001", "per-file", [INDEX], "SELECT false");
    const deferred: SchemaMigrationRecord = {
      id: "9001",
      variant: "shared",
      checksum: migration.checksum,
      status: "deferred",
      applied_at: new Date("2026-10-01T08:00:00.000Z"),
      applied_by: "render-api",
      evidence: { reason: "defer-unless precondition returned false" },
    };
    const { client, sent, after } = abortingClient(INDEX, "commit", [deferred]);

    await expect(applyMigrations(client, [migration], { applyDeferred: "9001" })).rejects.toMatchObject({ code: "XXA00" });
    expect(after("BEGIN").slice(-5)).toEqual([
      "DELETE FROM public.schema_migration_steps",
      "UPDATE public.schema_migrations",
      "UPDATE public.schema_migration_lock",
      "COMMIT",
      "UPDATE public.schema_migration_lock",
    ]);
    expect(sent.find((entry) => entry.sql === "UPDATE public.schema_migrations")?.values).toEqual([
      "9001",
      "deferred",
      deferred.applied_at,
      "render-api",
      JSON.stringify(deferred.evidence),
    ]);
    expect(sent.some((entry) => entry.sql === "DELETE FROM public.schema_migrations")).toBe(false);
  });

  it("removes only the failed step of a per-statement migration and never records the migration", async () => {
    const migration = definition("9002", "per-statement", [NORMALIZE, INDEX]);
    const { client, sent } = abortingClient(INDEX, "commit");

    await expect(applyMigrations(client, [migration])).rejects.toMatchObject({ code: "XXA00" });
    const deletes = sent.filter((entry) => entry.sql.startsWith("DELETE"));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.sql).toBe("DELETE FROM public.schema_migration_steps");
    expect(deletes[0]!.values?.slice(0, 3)).toEqual(["9002", "shared", 1]);
    expect(sent.filter((entry) => entry.sql === "INSERT INTO public.schema_migrations")).toEqual([]);
  });

  it("says the ledger may be wrong when the rows cannot be removed", async () => {
    const migration = definition("9001", "per-file", [INDEX]);
    const { client } = abortingClient(INDEX, "commit", [], { cleanupFails: true });

    const failure = await applyMigrations(client, [migration]).catch((error: unknown) => error);
    expect((failure as Error).message).toMatch(/^Migration 9001: CockroachDB rolled back its schema change after commit .* removing its ledger rows failed/);
    expect((failure as Error).message).toMatch(/run verify --schema/);
    expect((failure as Error).cause).toMatchObject({ message: "connection terminated" });
  });

  it("leaves the ledger alone when the statement itself fails and its transaction rolls back", async () => {
    const migration = definition("9001", "per-file", [INDEX]);
    const { client, after } = abortingClient(INDEX, "statement");

    await expect(applyMigrations(client, [migration])).rejects.toMatchObject({ code: "23505" });
    expect(after("CREATE UNIQUE INDEX")).toEqual(["CREATE UNIQUE INDEX", "ROLLBACK", "UPDATE public.schema_migration_lock"]);
  });
});
