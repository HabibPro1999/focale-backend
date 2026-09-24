import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ScratchDatabase } from "@app/db/testing";
import { createScratchDatabase } from "@app/db/testing";
import {
  acquireMigrationLease,
  assertLeaseAlive,
  releaseMigrationLease,
  runLeaseFencedTransaction,
} from "../../src/migrator";
import { dbTestsEnabled } from "../helpers/test-env";
import { dbTestSetupTimeoutMs } from "../../vitest.shared";

// Lease times must follow the wall clock inside a transaction. now() is the
// transaction's start time on both engines, so a fence based on it shortens
// the lease by the transaction's duration and accepts a lease that expired
// while the transaction was open.

const OWNER = "migrator:lease-clock-test";

describe.runIf(dbTestsEnabled())("migration lease clock inside open transactions", () => {
  let database: ScratchDatabase;

  beforeAll(async () => {
    database = await createScratchDatabase({ label: "lease_clock", to: "0000" });
    await database.client.query("CREATE TABLE lease_clock_work (note text NOT NULL)");
  }, dbTestSetupTimeoutMs());

  afterAll(async () => {
    await database?.close();
  }, dbTestSetupTimeoutMs());

  beforeEach(async () => {
    await releaseMigrationLease(database.client, OWNER);
    await acquireMigrationLease(database.client, OWNER);
  });

  async function secondsLeft(): Promise<number> {
    const { rows } = await database.client.query<{ left: string }>(
      `SELECT extract(epoch FROM lease_until - clock_timestamp())::text AS left
       FROM public.schema_migration_lock WHERE id = 1`,
    );
    return Number(rows[0]!.left);
  }

  /** Leave only this much of the held lease, measured now. */
  async function shortenLease(seconds: number): Promise<void> {
    await database.client.query(
      `UPDATE public.schema_migration_lock
       SET lease_until = clock_timestamp() + $1 * interval '1 second'
       WHERE id = 1 AND owner = $2`,
      [seconds, OWNER],
    );
  }

  async function notes(note: string): Promise<number> {
    const { rows } = await database.client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM lease_clock_work WHERE note = $1",
      [note],
    );
    return Number(rows[0]!.n);
  }

  it("leaves a full lease after a fenced transaction that ran for 2 s", async () => {
    await runLeaseFencedTransaction(database.client, OWNER, undefined, async () => {
      await database.client.query("INSERT INTO lease_clock_work (note) VALUES ('slow')");
      await database.client.query("SELECT pg_sleep(2)");
    });
    expect(await notes("slow")).toBe(1);
    // A fence that used the transaction's start time would leave about 88 s.
    expect(await secondsLeft()).toBeGreaterThanOrEqual(89);
  });

  it("refuses to commit when the lease expired while the transaction was open", async () => {
    await shortenLease(1);
    await expect(runLeaseFencedTransaction(database.client, OWNER, undefined, async () => {
      await database.client.query("INSERT INTO lease_clock_work (note) VALUES ('expired')");
      await database.client.query("SELECT pg_sleep(1.5)");
    })).rejects.toThrow(/lost or expired; refusing to commit/);
    expect(await notes("expired")).toBe(0);
    expect(await secondsLeft()).toBeLessThan(0);
  });

  it("reports a lease that expired inside the open transaction as lost", async () => {
    await shortenLease(1);
    await database.client.query("BEGIN");
    try {
      await database.client.query("INSERT INTO lease_clock_work (note) VALUES ('checked')");
      await database.client.query("SELECT pg_sleep(1.5)");
      await expect(assertLeaseAlive(database.client, OWNER)).rejects.toThrow(/lost or expired/);
    } finally {
      await database.client.query("ROLLBACK");
    }
  });
});
