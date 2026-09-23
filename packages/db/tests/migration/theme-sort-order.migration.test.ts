import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScratchDatabase } from "@app/db/testing";
import { createScratchDatabase } from "@app/db/testing";
import { dbTestsEnabled } from "../helpers/test-env";
import { dbTestSetupTimeoutMs } from "../../vitest.shared";

// Covers 0006_abstract_themes_sort_order_active_unique.sql only: the seeded
// duplicate repair (theme with issued codes keeps its slot) + the partial
// unique index backstop. Earlier migrations are asserted elsewhere.

const SEED = `
INSERT INTO "clients" ("id", "name", "updated_at") VALUES ('cl1', 'Client', now());
INSERT INTO "events" ("id", "client_id", "name", "slug", "start_date", "end_date", "updated_at")
  VALUES ('ev1', 'cl1', 'Event', 'event', now(), now(), now());
INSERT INTO "abstract_config" ("id", "event_id", "updated_at") VALUES ('cfg1', 'ev1', now());
-- Duplicate slot 2 among ACTIVE themes: t-coded has issued codes (counter
-- last_value > 0) and must keep the slot; t-loser must be bumped above the
-- config max (5). t-inactive shares the slot but is inactive: untouched.
-- t-max holds the max sortOrder. t-loser is older than t-coded, proving the
-- issued-codes criterion outranks created_at.
INSERT INTO "abstract_themes" ("id", "config_id", "label", "sort_order", "active", "created_at", "updated_at") VALUES
  ('t-coded',    'cfg1', 'Coded',    2, true,  '2026-02-01', now()),
  ('t-loser',    'cfg1', 'Loser',    2, true,  '2026-01-01', now()),
  ('t-inactive', 'cfg1', 'Inactive', 2, false, '2026-01-01', now()),
  ('t-max',      'cfg1', 'Max',      5, true,  '2026-01-01', now());
INSERT INTO "abstract_code_counters" ("id", "event_id", "theme_id", "final_type", "last_value", "updated_at")
  VALUES ('cnt1', 'ev1', 't-coded', 'ORAL_COMMUNICATION', 7, now());
`;

describe.runIf(dbTestsEnabled())("migration tier: 0006 theme sortOrder uniqueness", () => {
  let scratch: ScratchDatabase;

  beforeAll(async () => {
    scratch = await createScratchDatabase({ label: "theme_sort", to: "0005" });
    await scratch.client.query(SEED);
    await scratch.applyMigrations({ to: "0006" });
  }, dbTestSetupTimeoutMs());

  afterAll(async () => scratch?.close());

  it("keeps the coded theme in its slot and bumps the other duplicate above max", async () => {
    const { rows } = await scratch.client.query<{ id: string; sort_order: number }>(
      `SELECT "id", "sort_order" FROM "abstract_themes" ORDER BY "id"`,
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, Number(r.sort_order)]));
    expect(byId["t-coded"]).toBe(2); // issued codes outrank older created_at
    expect(byId["t-loser"]).toBe(6); // max(5) + 1
    expect(byId["t-inactive"]).toBe(2); // inactive: untouched
    expect(byId["t-max"]).toBe(5);
  });

  it("rejects a new ACTIVE duplicate via the partial unique index", async () => {
    await expect(
      scratch.client.query(
        `INSERT INTO "abstract_themes" ("id", "config_id", "label", "sort_order", "active", "updated_at")
         VALUES ('t-new', 'cfg1', 'New', 2, true, now())`,
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("still allows an INACTIVE theme in an occupied slot", async () => {
    await expect(
      scratch.client.query(
        `INSERT INTO "abstract_themes" ("id", "config_id", "label", "sort_order", "active", "updated_at")
         VALUES ('t-new-inactive', 'cfg1', 'NewInactive', 2, false, now())`,
      ),
    ).resolves.toBeTruthy();
  });
});
