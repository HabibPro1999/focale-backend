import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { defaultMigrationsDirectory } from "../../../src/migrator/migration";
import {
  buildNetworkingVectorIndex,
  networkingVectorIndexBuildBlocker,
  networkingVectorIndexReport,
} from "../../../src/ops/networking-vector-index";
import {
  clearNetworkingVectorIndexCache,
  networkingVectorIndexPresent,
  networkingVectorIndexStatus,
} from "../../../src/queries/networking-vector-search";
import { dbTestsEnabled } from "../../helpers/test-env";

// Plan 4.10 against a migrated database: index detection on both engines, and
// the runbook's ledger-backed build of a deferred 0017 on CockroachDB.
describe.runIf(dbTestsEnabled())("networking vector index status and runbook", () => {
  let client: Client;
  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client?.end();
  });

  it("reports the migrated schema: 0017's index on CockroachDB, none on PostgreSQL", async () => {
    const status = await networkingVectorIndexStatus();
    expect(status).toMatchObject({ eventsAboveThreshold: 0, fallbackActive: false });
    const report = await networkingVectorIndexReport(client);
    if (status.engine === "postgres") {
      expect(status.present).toBe(false);
      expect(report.migration).toBe("not-applicable");
      expect(networkingVectorIndexBuildBlocker(report)).toContain("PostgreSQL");
      await expect(buildNetworkingVectorIndex(client, {
        connectionString: process.env.DATABASE_URL!, migrationsDirectory: defaultMigrationsDirectory(),
      })).rejects.toThrow("PostgreSQL");
    } else {
      // CI enables feature.vector_index.enabled and the test database starts empty, so 0017 applies.
      expect(report).toMatchObject({ present: true, migration: "applied", featureEnabled: true });
      expect(networkingVectorIndexBuildBlocker(report)).toContain("already exists");
    }
  });

  it("recognizes a pgvector HNSW index on PostgreSQL", async ({ skip }) => {
    if ((await networkingVectorIndexStatus()).engine !== "postgres") skip();
    await client.query("CREATE INDEX networking_embeddings_hnsw_test ON networking_embeddings USING hnsw (embedding vector_cosine_ops)");
    try {
      expect(await networkingVectorIndexPresent()).toBe(true);
    } finally {
      await client.query("DROP INDEX networking_embeddings_hnsw_test");
    }
    expect(await networkingVectorIndexPresent()).toBe(false);
  });

  it("builds a deferred 0017 through the migration ledger on CockroachDB", async ({ skip }) => {
    if ((await networkingVectorIndexStatus()).engine !== "cockroach") skip();
    // Recreate the production state: 0017 recorded as deferred (a deferred
    // record has no step history), index absent.
    await client.query("DROP INDEX networking_embeddings@networking_embeddings_cosine_idx");
    await client.query("UPDATE schema_migrations SET status = 'deferred' WHERE id = '0017'");
    await client.query("DELETE FROM schema_migration_steps WHERE migration_id = '0017'");
    clearNetworkingVectorIndexCache();
    const deferred = await networkingVectorIndexReport(client);
    expect(deferred).toMatchObject({ present: false, migration: "deferred" });
    expect(networkingVectorIndexBuildBlocker(deferred)).toBeNull();
    const { after } = await buildNetworkingVectorIndex(client, {
      connectionString: process.env.DATABASE_URL!, migrationsDirectory: defaultMigrationsDirectory(), appliedBy: "vector-index-test",
    });
    expect(after).toMatchObject({ present: true, migration: "applied" });
    const ledger = await client.query<{ status: string; applied_by: string }>("SELECT status, applied_by FROM schema_migrations WHERE id = '0017'");
    expect(ledger.rows[0]).toMatchObject({ status: "applied", applied_by: "vector-index-test" });
  }, 300_000);
});
