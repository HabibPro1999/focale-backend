import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  records: vi.fn(),
  applyMigrations: vi.fn(),
  loadMigrations: vi.fn(),
}));
vi.mock("../queries/networking-vector-search", async (original) => ({
  ...(await original<typeof import("../queries/networking-vector-search")>()),
  networkingVectorIndexStatus: mocks.status,
}));
vi.mock("../migrator/migration", () => ({ loadMigrations: mocks.loadMigrations }));
vi.mock("../migrator/runner", () => ({
  applyMigrations: mocks.applyMigrations,
  databaseEngine: async () => "cockroach",
  listMigrationRecords: mocks.records,
  migrationLedgerExists: async () => true,
  normalizeAppliedBy: (value: string) => value,
  setUtcSession: async () => undefined,
}));

import type { Client } from "pg";
import { buildNetworkingVectorIndex } from "./networking-vector-index";

const client = {
  query: vi.fn(async (text: string) =>
    text.startsWith("SHOW CLUSTER SETTING") ? { rows: [{ "feature.vector_index.enabled": true }] } : { rows: [{ count: 18_000 }] }),
} as unknown as Client;
const migration = (id: string) => ({ id });
const status = (present: boolean) => ({ engine: "cockroach", present, eventsAboveThreshold: 1, threshold: 5000, fallbackActive: !present });
const record = (id: string, state = "applied") => ({ id, status: state });

describe("buildNetworkingVectorIndex", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadMigrations.mockResolvedValue(["0016", "0017", "0018", "0022"].map(migration));
    mocks.status.mockResolvedValueOnce(status(false)).mockResolvedValueOnce(status(true));
    mocks.applyMigrations.mockResolvedValue({ engine: "cockroach", applied: ["0017"], deferred: [], skipped: [], unknownPreconditions: [] });
  });
  it("gives the runner every known migration, so later ledger rows are not unknown, and applies only through 0017", async () => {
    mocks.records.mockResolvedValue([record("0016"), record("0017", "deferred"), record("0018"), record("0022")]);
    const result = await buildNetworkingVectorIndex(client, { connectionString: "postgresql://x", migrationsDirectory: "/m", appliedBy: "ops" });
    expect(mocks.loadMigrations).toHaveBeenCalledWith("/m", "cockroach");
    const [, migrations, options] = mocks.applyMigrations.mock.calls[0]!;
    expect(migrations.map((row: { id: string }) => row.id)).toEqual(["0016", "0017", "0018", "0022"]);
    expect(options).toMatchObject({ through: "0017", applyDeferred: "0017", appliedBy: "ops", leaseConnectionString: "postgresql://x" });
    expect(result.after.present).toBe(true);
  });
  it("refuses while an earlier migration is pending, but not for pending later ones", async () => {
    mocks.records.mockResolvedValue([record("0017", "deferred"), record("0018")]);
    await expect(buildNetworkingVectorIndex(client, { connectionString: "postgresql://x", migrationsDirectory: "/m" }))
      .rejects.toThrow("Migrations 0016 are pending");
    expect(mocks.applyMigrations).not.toHaveBeenCalled();
    mocks.status.mockReset().mockResolvedValueOnce(status(false)).mockResolvedValueOnce(status(true));
    mocks.records.mockResolvedValue([record("0016"), record("0017", "deferred")]);
    await buildNetworkingVectorIndex(client, { connectionString: "postgresql://x", migrationsDirectory: "/m" });
    expect(mocks.applyMigrations).toHaveBeenCalledOnce();
  });
});
