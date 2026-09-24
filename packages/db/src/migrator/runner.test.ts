import type { Client } from "pg";
import { describe, expect, it } from "vitest";
import {
  LEASE_FENCED_TRANSACTION_ATTEMPTS,
  applyMigrations,
  listMigrationStepRecords,
  runLeaseFencedTransaction,
} from "./runner";
import type { MigrationDefinition } from "./migration";

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
