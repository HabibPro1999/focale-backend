import type { Client } from "pg";
import { describe, expect, it } from "vitest";
import { inspectMigrationCatalog } from "./catalog";
import type { MigrationDefinition } from "./migration";

describe("migration catalog verification", () => {
  it("runs probes sequentially on a single PostgreSQL client", async () => {
    let activeQueries = 0;
    let maximumActiveQueries = 0;
    const client = {
      async query() {
        activeQueries += 1;
        maximumActiveQueries = Math.max(maximumActiveQueries, activeQueries);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeQueries -= 1;
        return { rows: [{ passed: true }] };
      },
    } as unknown as Client;
    const migration: MigrationDefinition = {
      id: "9999",
      name: "catalog_probe_fixture",
      variant: "shared",
      filePath: "9999_catalog_probe_fixture.sql",
      source: "fixture",
      checksum: "a".repeat(64),
      directives: {
        transaction: "per-file",
        requiresExtensions: [],
        idempotent: false,
        deferrable: false,
        verify: ["SELECT true AS passed", "SELECT true AS passed"],
      },
      statements: [],
    };

    const report = await inspectMigrationCatalog(client, "postgres", migration);

    expect(report.state).toBe("all");
    expect(maximumActiveQueries).toBe(1);
  });
});
