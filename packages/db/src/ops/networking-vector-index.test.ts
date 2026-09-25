import { describe, expect, it } from "vitest";
import {
  formatNetworkingVectorIndexReport,
  networkingVectorIndexBuildBlocker,
  type NetworkingVectorIndexReport,
} from "./networking-vector-index";

const report = (overrides: Partial<NetworkingVectorIndexReport> = {}): NetworkingVectorIndexReport => ({
  engine: "cockroach", present: false, eventsAboveThreshold: 1, threshold: 5000, fallbackActive: true,
  migration: "deferred", featureEnabled: true, embeddingRows: 18_000, ...overrides,
});

describe("networking vector index runbook", () => {
  it("builds only a missing CockroachDB index whose 0017 is deferred and whose feature is on", () => {
    expect(networkingVectorIndexBuildBlocker(report())).toBeNull();
    // An unreadable setting (no admin privileges) is not a refusal; the migrator checks it again.
    expect(networkingVectorIndexBuildBlocker(report({ featureEnabled: null }))).toBeNull();
    for (const [overrides, reason] of [
      [{ engine: "postgres", migration: "not-applicable", featureEnabled: null }, "PostgreSQL has no ANN index migration"],
      [{ present: true, migration: "applied" }, "already exists"],
      [{ migration: "no-ledger" }, "adopt the database first"],
      [{ migration: "pending" }, "run migrator apply --yes first"],
      [{ migration: "applied" }, "verify --schema"],
      [{ featureEnabled: false }, "SET CLUSTER SETTING feature.vector_index.enabled = true"],
    ] as const)
      expect(networkingVectorIndexBuildBlocker(report(overrides))).toContain(reason);
  });
  it("prints the facts an operator needs", () => {
    expect(formatNetworkingVectorIndexReport(report())).toEqual([
      "engine: cockroach",
      "ANN index: missing (networking_embeddings_cosine_idx)",
      "migration 0017: deferred",
      "feature.vector_index.enabled: true",
      "embedding rows: 18000",
      "events above 5000 embedded profiles: 1",
      "recommendations: deterministic profile rules for those events (index missing)",
    ]);
    expect(formatNetworkingVectorIndexReport(report({ present: true, fallbackActive: false, engine: "postgres", featureEnabled: null })))
      .toEqual(expect.arrayContaining(["ANN index: present", "feature.vector_index.enabled: n/a or unreadable", "recommendations: vector ranking"]));
  });
});
