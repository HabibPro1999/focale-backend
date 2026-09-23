import type { Client } from "pg";
import { describe, expect, it } from "vitest";
import { listMigrationStepRecords } from "./runner";

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
