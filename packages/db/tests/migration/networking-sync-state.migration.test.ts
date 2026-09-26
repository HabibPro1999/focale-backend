import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScratchDatabase } from "@app/db/testing";
import { createScratchDatabase } from "@app/db/testing";
import { splitMigrationStatements } from "../../src/migrator/migration";
import { dbTestsEnabled } from "../helpers/test-env";
import { dbTestSetupTimeoutMs } from "../../vitest.shared";

const COLUMNS = [
  "sync_run_id",
  "sync_status",
  "sync_cursor",
  "sync_total",
  "sync_processed",
  "sync_created",
  "sync_updated",
  "sync_failed",
  "sync_requested_at",
  "sync_finished_at",
  "sync_error",
];

// 4.8: 0035 adds the full-event sync state to networking_configs (per
// statement, idempotent). Existing config rows start with no run.
describe.runIf(dbTestsEnabled())("migration tier: networking sync state (0035)", () => {
  let scratch: ScratchDatabase;

  async function columns(): Promise<Map<string, { type: string; nullable: string; default: string | null }>> {
    const { rows } = await scratch.client.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'networking_configs' AND column_name = ANY($1)`,
      [COLUMNS],
    );
    return new Map(
      rows.map((row) => [row.column_name, { type: row.data_type, nullable: row.is_nullable, default: row.column_default }]),
    );
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase({ label: "networking_sync_state", to: "0034" });
    await scratch.client.query(`
      INSERT INTO clients (id, name, updated_at) VALUES ('cli-1', 'Client', now());
      INSERT INTO events (id, client_id, name, slug, start_date, end_date, updated_at)
      VALUES ('evt-1', 'cli-1', 'Event', 'event', now(), now(), now());
      INSERT INTO networking_configs (event_id, config, updated_at) VALUES ('evt-1', '{"enabled": true}', now());
    `);
  }, dbTestSetupTimeoutMs());
  afterAll(async () => scratch?.close());

  it("before 0035, networking_configs has no sync state", async () => {
    expect(await columns()).toEqual(new Map());
  });

  it("0035 adds the sync state; an existing config row starts with no run", async () => {
    const { applied } = await scratch.applyMigrations({ to: "0035" });
    expect(applied.at(-1)).toBe("0035");
    const found = await columns();
    expect([...found.keys()].sort()).toEqual([...COLUMNS].sort());
    for (const name of ["sync_run_id", "sync_status", "sync_cursor", "sync_error"])
      expect(found.get(name)).toMatchObject({ type: expect.stringMatching(/^(text|character varying)$/i), nullable: "YES" });
    for (const name of ["sync_total", "sync_processed", "sync_created", "sync_updated", "sync_failed"]) {
      expect(found.get(name)).toMatchObject({ type: expect.stringMatching(/^(integer|bigint)$/i), nullable: "NO" });
      expect(found.get(name)!.default).toMatch(/^0(:::INT8)?$/i);
    }
    for (const name of ["sync_requested_at", "sync_finished_at"])
      expect(found.get(name)).toMatchObject({ type: expect.stringMatching(/^timestamp with time zone$/i), nullable: "YES" });

    const { rows } = await scratch.client.query(
      `SELECT sync_run_id, sync_status, sync_cursor, sync_total, sync_processed, sync_created, sync_updated,
              sync_failed, sync_requested_at, sync_finished_at, sync_error
       FROM networking_configs WHERE event_id = 'evt-1'`,
    );
    expect(rows).toHaveLength(1);
    expect(Object.values(rows[0]!).map((value) => (value === null ? null : Number(value)))).toEqual([
      null, null, null, 0, 0, 0, 0, 0, null, null, null,
    ]);
    await scratch.client.query(
      `UPDATE networking_configs SET sync_run_id = 'run-1', sync_status = 'RUNNING', sync_cursor = 'reg-1',
         sync_total = 3, sync_processed = sync_processed + 1, sync_requested_at = now(), sync_error = 'boom'
       WHERE event_id = 'evt-1'`,
    );
  });

  it("ends in the same state when its statements run again (crash recovery)", async () => {
    const before = await columns();
    const source = await readFile(resolve(__dirname, "../../migrations/0035_networking_sync_state.sql"), "utf8");
    for (const statement of splitMigrationStatements(source)) await scratch.client.query(statement);
    expect(await columns()).toEqual(before);
    const { rows } = await scratch.client.query<{ sync_status: string; sync_processed: number | string }>(
      `SELECT sync_status, sync_processed FROM networking_configs WHERE event_id = 'evt-1'`,
    );
    expect(rows.map((row) => ({ status: row.sync_status, processed: Number(row.sync_processed) }))).toEqual([
      { status: "RUNNING", processed: 1 },
    ]);
  });
});
