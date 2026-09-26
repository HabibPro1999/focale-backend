import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScratchDatabase } from "@app/db/testing";
import { createScratchDatabase } from "@app/db/testing";
import { splitMigrationStatements } from "../../src/migrator/migration";
import { dbTestsEnabled } from "../helpers/test-env";
import { dbTestSetupTimeoutMs } from "../../vitest.shared";

const INDEXES = [
  "networking_deliveries_claim_idx",
  "networking_deliveries_otp_claim_idx",
  "networking_deliveries_event_idx",
  "networking_profiles_erasure_due_idx",
  "networking_profiles_withdrawn_idx",
];

// 4.2: 0031 adds one partial claim index per delivery lane, the deliveries
// event index, and the erasure-due profile index that replaces 0025's
// networking_profiles_withdrawn_idx.
describe.runIf(dbTestsEnabled())("migration tier: networking delivery lanes (0031)", () => {
  let scratch: ScratchDatabase;

  async function indexes(): Promise<Map<string, string>> {
    const { rows } = await scratch.client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_catalog.pg_indexes
       WHERE schemaname = 'public' AND indexname = ANY($1)`,
      [INDEXES],
    );
    return new Map(rows.map((row) => [row.indexname, row.indexdef.replace(/\s+/g, " ")]));
  }

  async function rerun() {
    const source = await readFile(resolve(__dirname, "../../migrations/0031_networking_delivery_lanes.sql"), "utf8");
    for (const statement of splitMigrationStatements(source)) await scratch.client.query(statement);
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase({ label: "networking_delivery_lanes", to: "0029" });
  }, dbTestSetupTimeoutMs());
  afterAll(async () => scratch?.close());

  it("before 0031, only 0025's withdrawn index exists", async () => {
    expect([...(await indexes()).keys()]).toEqual(["networking_profiles_withdrawn_idx"]);
  });

  it("0031 adds the lane claim, event and erasure-due indexes and drops the superseded one", async () => {
    const { applied } = await scratch.applyMigrations({ to: "0031" });
    expect(applied.at(-1)).toBe("0031");
    const found = await indexes();
    expect([...found.keys()].sort()).toEqual([
      "networking_deliveries_claim_idx",
      "networking_deliveries_event_idx",
      "networking_deliveries_otp_claim_idx",
      "networking_profiles_erasure_due_idx",
    ]);
    // Engines print predicates differently (casts, !=/<>); check the parts.
    const claim = found.get("networking_deliveries_claim_idx")!;
    expect(claim).toMatch(/\(available_at(?: ASC)?\)/i);
    expect(claim).toMatch(/type\)?\s*(?:<>|!=)\s*'OTP'/i);
    expect(claim).toMatch(/PENDING.*PROCESSING.*FAILED/);
    expect(claim).toMatch(/attempts\)?\s*<\s*5/);
    const otp = found.get("networking_deliveries_otp_claim_idx")!;
    expect(otp).toMatch(/\(available_at(?: ASC)?\)/i);
    expect(otp).toMatch(/type\)?\s*=\s*'OTP'/i);
    expect(found.get("networking_deliveries_event_idx")).toMatch(/\(event_id(?: ASC)?\)/i);
    const erasure = found.get("networking_profiles_erasure_due_idx")!;
    expect(erasure).toMatch(/\(withdrawn_at(?: ASC)?\)/i);
    expect(erasure).toMatch(/withdrawn_at IS NOT NULL/i);
    expect(erasure).toMatch(/erased_at IS NULL/i);
  });

  it("ends in the same state when its statements run again (crash recovery)", async () => {
    const before = await indexes();
    await rerun();
    expect(await indexes()).toEqual(before);
  });
});
