import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScratchDatabase } from "@app/db/testing";
import { createScratchDatabase } from "@app/db/testing";
import {
  defaultMigrationsDirectory,
  loadMigrations,
  splitMigrationStatements,
  verifyMigrations,
} from "../../src/migrator";
import { dbTestsEnabled } from "../helpers/test-env";
import { dbTestSetupTimeoutMs } from "../../vitest.shared";

// 6.5: 0033 drops the unused legacy abstract_code_sequences table (and its
// unique index), rows included.
describe.runIf(dbTestsEnabled())("migration tier: drop abstract_code_sequences (0033)", () => {
  let scratch: ScratchDatabase;

  async function leftovers(): Promise<{ tables: string[]; indexes: string[] }> {
    const tables = await scratch.client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'abstract_code_sequences'`,
    );
    const indexes = await scratch.client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_catalog.pg_indexes
       WHERE schemaname = 'public' AND indexname = 'abstract_code_sequences_final_type_key'`,
    );
    return {
      tables: tables.rows.map((row) => row.table_name),
      indexes: indexes.rows.map((row) => row.indexname),
    };
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase({ label: "abstract_code_sequences_drop", to: "0032" });
    await scratch.client.query(`
      INSERT INTO abstract_code_sequences (id, final_type, last_value, updated_at)
      VALUES ('seq-1', 'ORAL_COMMUNICATION', 7, now())
    `);
  }, dbTestSetupTimeoutMs());
  afterAll(async () => scratch?.close());

  it("before 0033, the table and its unique index exist", async () => {
    expect(await leftovers()).toEqual({
      tables: ["abstract_code_sequences"],
      indexes: ["abstract_code_sequences_final_type_key"],
    });
  });

  it("0033 drops the table and the index, and the schema verifies", async () => {
    expect((await scratch.applyMigrations({ to: "0033" })).applied).toEqual(["0033"]);
    expect(await leftovers()).toEqual({ tables: [], indexes: [] });

    const migrations = (await loadMigrations(defaultMigrationsDirectory(), scratch.engine))
      .filter((migration) => migration.id <= "0033");
    const verification = await verifyMigrations(scratch.client, scratch.engine, migrations, { schema: true });
    expect(verification.errors).toEqual([]);
  });

  it("running its statements again changes nothing (crash recovery)", async () => {
    const source = await readFile(
      resolve(__dirname, "../../migrations/0033_drop_abstract_code_sequences.sql"),
      "utf8",
    );
    for (const statement of splitMigrationStatements(source)) await scratch.client.query(statement);
    expect(await leftovers()).toEqual({ tables: [], indexes: [] });
  });
});
