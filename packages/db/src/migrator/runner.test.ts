import type { Client } from "pg";
import { describe, expect, it } from "vitest";
import { applyMigrations, listMigrationStepRecords } from "./runner";
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
