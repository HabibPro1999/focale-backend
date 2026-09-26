import { describe, expect, it } from "vitest";
import { deriveCatalogProbes } from "./catalog";
import {
  adoptionCatalogState,
  decideAdoption,
  formatAdoptionReport,
  legacyTracking,
  mapLegacyNetworkingRows,
  supersededObjectProbes,
  type AdoptionCatalogState,
  type LegacyNetworkingRow,
  type LegacyNetworkingState,
} from "./adopt";
import { LEGACY_NETWORKING_0018_CROSSWALK, LEGACY_NETWORKING_FILE_CHECKSUMS } from "./legacy-networking";
import {
  defaultMigrationsDirectory,
  loadMigrations,
  migrationChecksum,
  parseMigrationDirectives,
  splitMigrationStatements,
  type MigrationDefinition,
} from "./migration";
import type { CatalogObjectProbe, MigrationAdoptionReport, MigrationCatalogReport } from "./types";

function fixture(id: string, idempotent: boolean): MigrationDefinition {
  return {
    id,
    name: `${id}_fixture.sql`,
    variant: "shared",
    filePath: `${id}_fixture.sql`,
    source: "SELECT 1",
    checksum: "a".repeat(64),
    directives: { transaction: "per-file", requiresExtensions: [], idempotent, deferrable: false, verify: [] },
    statements: ["SELECT 1"],
  };
}

const untracked: LegacyNetworkingState = { kind: "untracked" };

function decide(
  migration: MigrationDefinition,
  catalog: AdoptionCatalogState,
  legacy: LegacyNetworkingState = untracked,
  prismaBaseline = false,
) {
  return decideAdoption({ migration, catalog, legacy, prismaBaseline });
}

describe("decideAdoption (plan decision rules)", () => {
  const plain = fixture("0005", false);
  const idempotent = fixture("0006", true);

  it("classifies by catalog probes when no legacy ledger tracks the migration", () => {
    expect(decide(plain, "all")).toEqual({ classification: "applied", carriedSteps: [] });
    expect(decide(plain, "none")).toEqual({ classification: "pending", carriedSteps: [] });
    expect(decide(idempotent, "partial")).toEqual({ classification: "pending", carriedSteps: [] });
    expect(decide(plain, "partial").abort).toMatch(/^0005: catalog probes partially match a non-idempotent/);
    expect(decide(idempotent, "unverifiable")).toEqual({ classification: "pending", carriedSteps: [] });
    expect(decide(plain, "unverifiable").abort).toMatch(/non-idempotent/);
  });

  it("records 0000 as baseline only when _prisma_migrations agrees with the probes", () => {
    const init = fixture("0000", false);
    expect(decide(init, "all", untracked, true)).toEqual({ classification: "baseline", carriedSteps: [] });
    expect(decide(init, "partial", untracked, true).abort).toMatch(/_prisma_migrations/);
    expect(decide(init, "none", untracked, true).abort).toMatch(/_prisma_migrations/);
    // Without Prisma evidence 0000 is an ordinary non-idempotent file.
    expect(decide(init, "all")).toEqual({ classification: "applied", carriedSteps: [] });
    expect(decide(init, "partial").abort).toMatch(/non-idempotent/);
  });

  it("aborts when the legacy networking ledger disagrees with the probes", () => {
    const applied: LegacyNetworkingState = { kind: "applied", name: "0015_x.sql", checksum: "c", steps: [] };
    expect(decide(plain, "all", applied)).toEqual({ classification: "applied", carriedSteps: [] });
    expect(decide(plain, "partial", applied).abort).toMatch(/records 0015_x.sql as applied/);
    expect(decide(plain, "none", applied).abort).toMatch(/records 0015_x.sql as applied/);

    const absent: LegacyNetworkingState = { kind: "absent", name: "0015_x.sql" };
    expect(decide(plain, "all", absent).abort).toMatch(/has no record of 0015_x.sql/);
    expect(decide(plain, "none", absent)).toEqual({ classification: "pending", carriedSteps: [] });
    expect(decide(plain, "partial", absent).abort).toMatch(/non-idempotent/);

    expect(decide(plain, "all", { kind: "invalid", name: "0015_x.sql", reason: "bad checksum" }).abort).toBe(
      "0005: bad checksum",
    );
  });

  it("carries interrupted legacy steps of an idempotent migration so apply resumes", () => {
    const steps: LegacyNetworkingState = { kind: "steps", name: "0018_x.sql", steps: [0, 1, 2, 3, 4] };
    expect(decide(idempotent, "partial", steps)).toEqual({ classification: "pending", carriedSteps: [0, 1, 2, 3, 4] });
    expect(decide(idempotent, "all", steps)).toEqual({ classification: "pending", carriedSteps: [0, 1, 2, 3, 4] });
    expect(decide(idempotent, "none", steps).abort).toMatch(/none of its objects exist/);
    expect(decide(plain, "partial", steps).abort).toMatch(/non-idempotent/);
    const done: LegacyNetworkingState = { kind: "applied", name: "0018_x.sql", checksum: "c", steps: [0, 1] };
    expect(decide(idempotent, "all", done)).toEqual({ classification: "applied", carriedSteps: [0, 1] });
  });
});

describe("legacy networking ledger mapping", () => {
  const directory = defaultMigrationsDirectory();
  const checksums: Record<string, string> = LEGACY_NETWORKING_FILE_CHECKSUMS;

  function legacyRows(migrations: MigrationDefinition[]): LegacyNetworkingRow[] {
    return migrations
      .map((migration) => legacyTracking(migration))
      .filter((tracking): tracking is NonNullable<typeof tracking> => Boolean(tracking))
      .map((tracking) => ({ name: tracking.name, checksum: tracking.checksum }));
  }

  const crosswalkSteps = (indexes: number[]) =>
    indexes.map((index) => ({
      name: `0018_networking_spaces.sql:step:${index}`,
      checksum: LEGACY_NETWORKING_0018_CROSSWALK.steps[index]!.legacyChecksum,
    }));

  it("tracks exactly the files the old script recorded", async () => {
    const cockroach = await loadMigrations(directory, "cockroach");
    const tracked = cockroach
      .map((migration) => [migration.id, legacyTracking(migration)?.name] as const)
      .filter(([, name]) => name);
    expect(tracked).toEqual([
      ["0012", "0012_networking.sql"],
      ["0013", "0013_networking_embeddings.sql"],
      ["0014", "0014_registration_networking_opt_in.sql"],
      ["0015", "0015_networking_mfa.sql"],
      ["0016", "0016_networking_read_indexes.sql"],
      ["0017", "cockroach/0017_networking_vector_index.sql"],
      ["0018", "0018_networking_spaces.sql"],
      ["0019", "0019_networking_alignment.sql"],
    ]);
    expect(legacyTracking(cockroach.find((m) => m.id === "0017")!)?.checksum).toBe(checksums["0017:cockroach"]);
  });

  it("maps a complete CockroachDB old-script ledger, including the 0018 steps", async () => {
    const cockroach = await loadMigrations(directory, "cockroach");
    const rows = [...legacyRows(cockroach), ...crosswalkSteps([...Array(12).keys()])];
    const { states, unknown } = mapLegacyNetworkingRows(cockroach, rows);
    expect(unknown).toEqual([]);
    expect(states.get("0011")).toEqual({ kind: "untracked" });
    expect(states.get("0017")).toMatchObject({ kind: "applied" });
    expect(states.get("0018")).toEqual({
      kind: "applied",
      name: "0018_networking_spaces.sql",
      checksum: LEGACY_NETWORKING_0018_CROSSWALK.legacyFileChecksum,
      steps: [...Array(12).keys()],
    });
  });

  it("recognises an interrupted 0018 and rejects inconsistent ledgers", async () => {
    const cockroach = await loadMigrations(directory, "cockroach");
    const withoutLate = legacyRows(cockroach).filter((row) => !/^001[89]/.test(row.name));
    const interrupted = mapLegacyNetworkingRows(cockroach, [...withoutLate, ...crosswalkSteps([0, 1, 2, 3, 4])]);
    expect(interrupted.states.get("0018")).toEqual({ kind: "steps", name: "0018_networking_spaces.sql", steps: [0, 1, 2, 3, 4] });
    expect(interrupted.states.get("0019")).toEqual({ kind: "absent", name: "0019_networking_alignment.sql" });

    const fileRowOnly = mapLegacyNetworkingRows(cockroach, legacyRows(cockroach));
    expect(fileRowOnly.states.get("0018")).toMatchObject({ kind: "invalid", reason: expect.stringMatching(/without all of its step rows/) });

    const tampered = legacyRows(cockroach).map((row) => (row.name.startsWith("0015") ? { ...row, checksum: "0".repeat(64) } : row));
    expect(mapLegacyNetworkingRows(cockroach, tampered).states.get("0015")).toMatchObject({
      kind: "invalid",
      reason: expect.stringMatching(/does not match the known historical file/),
    });

    const badStep = [{ name: "0018_networking_spaces.sql:step:3", checksum: "f".repeat(64) }];
    expect(mapLegacyNetworkingRows(cockroach, badStep).states.get("0018")).toMatchObject({ kind: "invalid" });

    const extra = mapLegacyNetworkingRows(cockroach, [...legacyRows(cockroach), { name: "0020_future.sql", checksum: "x" }]);
    expect(extra.unknown).toEqual(["0020_future.sql"]);
  });

  it("treats PostgreSQL 0018 as a whole-file record and rejects step rows there", async () => {
    const postgres = await loadMigrations(directory, "postgres");
    const { states } = mapLegacyNetworkingRows(postgres, legacyRows(postgres));
    expect(states.get("0018")).toMatchObject({ kind: "applied", steps: [] });
    expect(postgres.some((migration) => migration.id === "0017")).toBe(false);
    const stepped = mapLegacyNetworkingRows(postgres, [...legacyRows(postgres), ...crosswalkSteps([0])]);
    expect(stepped.states.get("0018")).toMatchObject({ kind: "invalid", reason: expect.stringMatching(/unexpected step rows/) });
    expect(mapLegacyNetworkingRows(postgres, null).states.get("0015")).toEqual({ kind: "untracked" });
  });
});

describe("adoptionCatalogState", () => {
  const probe = (name: string, extra: Partial<CatalogObjectProbe> = {}): CatalogObjectProbe => ({
    migrationId: "0018",
    variant: "shared",
    statementIndex: 0,
    kind: "index",
    name,
    expectedPresent: true,
    source: "ddl",
    ...extra,
  });
  const report = (results: Array<[CatalogObjectProbe, boolean]>): MigrationCatalogReport => ({
    migrationId: "0018",
    variant: "shared",
    matched: results.filter(([, passed]) => passed).length,
    total: results.length,
    state: "partial",
    probes: results.map(([p, passed]) => ({ probe: p, passed })),
  });

  it("does not count an absence probe as evidence before the created objects exist", () => {
    const dropped = probe("old_key", { expectedPresent: false });
    expect(adoptionCatalogState(report([[probe("new_a"), false], [probe("new_b"), false], [dropped, true]])).state).toBe("none");
    expect(adoptionCatalogState(report([[probe("new_a"), true], [probe("new_b"), true], [dropped, true]])).state).toBe("all");
    const stillThere = adoptionCatalogState(report([[probe("new_a"), true], [probe("new_b"), true], [dropped, false]]));
    expect(stillThere).toEqual({
      state: "partial",
      matched: 2,
      total: 3,
      failed: ["index old_key (absent)"],
      superseded: [],
    });
    // Absence-only migrations (0002) are judged on their absence probes.
    expect(adoptionCatalogState(report([[dropped, true]])).state).toBe("all");
  });

  it("ignores extension prerequisites and reports unverifiable files", () => {
    const extension = probe("vector", { kind: "extension", source: "directive", statementIndex: -1 });
    expect(adoptionCatalogState(report([[extension, true], [probe("t", { kind: "table" }), false]])).state).toBe("none");
    expect(adoptionCatalogState(report([])).state).toBe("unverifiable");
  });
});

describe("superseded probes", () => {
  it("judges an object only by the last migration that declares it", async () => {
    for (const engine of ["postgres", "cockroach"] as const) {
      const migrations = await loadMigrations(defaultMigrationsDirectory(), engine);
      const superseded = supersededObjectProbes(migrations);
      const nonEmpty = [...superseded].filter(([, keys]) => keys.size > 0);
      // 0018 drops the per-event table-name index that 0012 creates; 0024
      // rebuilds two 0001 email_logs indexes under the same names; 0031
      // replaces 0025's withdrawn-profile index with the erasure-due one.
      expect(nonEmpty).toEqual([
        ["0025", new Map([["index:networking_profiles_withdrawn_idx", "0031"]])],
        ["0012", new Map([["index:networking_tables_event_name_key", "0018"]])],
        [
          "0001",
          new Map([
            ["index:email_logs_registration_trigger_active_key", "0024"],
            ["index:email_logs_template_recipient_trigger_active_key", "0024"],
          ]),
        ],
      ]);
    }
  });

  it("does not count a superseded probe against the earlier migration", async () => {
    const migrations = await loadMigrations(defaultMigrationsDirectory(), "postgres");
    const networking = migrations.find((migration) => migration.id === "0012")!;
    const probes = deriveCatalogProbes(networking);
    // A database that also ran 0018: every 0012 object exists except the dropped index.
    const results = probes.map((probe) => ({
      probe,
      passed: "query" in probe || probe.name !== "networking_tables_event_name_key",
    }));
    const report: MigrationCatalogReport = {
      migrationId: "0012",
      variant: "shared",
      matched: results.filter((result) => result.passed).length,
      total: results.length,
      state: "partial",
      probes: results,
    };
    expect(adoptionCatalogState(report).state).toBe("partial");
    const view = adoptionCatalogState(report, supersededObjectProbes(migrations).get("0012"));
    expect(view.state).toBe("all");
    expect(view.total).toBe(probes.length - 1);
    expect(view.superseded).toEqual(["index networking_tables.networking_tables_event_name_key (declared again by 0018)"]);
  });

  it("judges 0024 by its verify probe, since 0001 already created the same index names", async () => {
    const migrations = await loadMigrations(defaultMigrationsDirectory(), "postgres");
    const rebuild = migrations.find((migration) => migration.id === "0024")!;
    expect(rebuild.directives.idempotent).toBe(true);
    const probes = deriveCatalogProbes(rebuild);
    // Every index probe passes on a database that only ran 0001 (same names,
    // no *_rebuild left); only the definition check tells the two apart.
    const state = (definitionsRebuilt: boolean) => {
      const results = probes.map((probe) => ({ probe, passed: "query" in probe ? definitionsRebuilt : true }));
      return adoptionCatalogState({
        migrationId: "0024",
        variant: "shared",
        matched: results.filter((result) => result.passed).length,
        total: results.length,
        state: "partial",
        probes: results,
      }).state;
    };
    expect(state(false)).toBe("partial");
    expect(state(true)).toBe("all");
  });
});

describe("a plain ADD COLUMN migration (later files such as 0020)", () => {
  const source = [
    "-- migrate: transaction per-file",
    "-- A later column addition, not tracked by the old networking runner.",
    "ALTER TABLE networking_challenges ADD COLUMN verified_at TIMESTAMPTZ(3);",
    "",
  ].join("\n");
  const migration: MigrationDefinition = {
    id: "0099",
    name: "0099_add_column_fixture.sql",
    variant: "shared",
    filePath: "0099_add_column_fixture.sql",
    source,
    checksum: migrationChecksum(source),
    directives: parseMigrationDirectives(source, "0099_add_column_fixture.sql"),
    statements: splitMigrationStatements(source),
  };

  it("derives a column probe and is classified from it alone", () => {
    expect(deriveCatalogProbes(migration)).toEqual([
      expect.objectContaining({ kind: "column", table: "networking_challenges", name: "verified_at", expectedPresent: true }),
    ]);
    expect(legacyTracking(migration)).toBeUndefined();
    expect(decide(migration, "all")).toEqual({ classification: "applied", carriedSteps: [] });
    expect(decide(migration, "none")).toEqual({ classification: "pending", carriedSteps: [] });
  });
});

describe("formatAdoptionReport", () => {
  it("prints classifications, evidence and aborts with credentials redacted", () => {
    const migration = fixture("0015", false);
    const report: MigrationAdoptionReport = {
      engine: "cockroach",
      assessments: [
        {
          migration,
          abort: "0015: failed near postgres://admin:hunter2@db.internal/app",
          evidence: {
            source: "adopt",
            catalog: { state: "partial", matched: 1, total: 2, failed: ["table networking_second_factors"] },
            legacyNetworking: { name: "0015_networking_mfa.sql", recorded: true },
          },
          catalog: { migrationId: "0015", variant: "shared", matched: 1, total: 2, state: "partial", probes: [] },
          carriedSteps: [],
        },
      ],
      warnings: [],
      errors: ["0015: failed near postgres://admin:hunter2@db.internal/app"],
      aborted: true,
      written: { migrations: 0, steps: 0 },
    };
    const text = formatAdoptionReport(report, true).join("\n");
    expect(text).toContain("0015 ABORT");
    expect(text).toContain("probes 1/2 (partial); networking_migrations recorded");
    expect(text).toContain("missing: table networking_second_factors");
    expect(text).toContain("Adoption aborted; nothing was written.");
    expect(text).not.toContain("hunter2");
  });
});
