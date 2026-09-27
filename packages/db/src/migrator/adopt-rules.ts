import { catalogObjectKey, deriveCatalogProbes } from "./catalog";
import type { MigrationDefinition } from "./migration";
import type { LegacyNetworkingState } from "./legacy-networking";
import type {
  AdoptionClassification,
  CatalogObjectProbe,
  CatalogSqlProbe,
  MigrationCatalogReport,
} from "./types";

export type AdoptionCatalogState = MigrationCatalogReport["state"];

type Probe = CatalogObjectProbe | CatalogSqlProbe;

function isAbsenceProbe(probe: Probe): boolean {
  return !("query" in probe) && !probe.expectedPresent;
}

/** `requires-extension` is a prerequisite check, not an object the file creates. */
function isPrerequisiteProbe(probe: Probe): boolean {
  return !("query" in probe) && probe.kind === "extension";
}

export function describeProbe(probe: Probe): string {
  if ("query" in probe) return `verify ${probe.query.length > 80 ? `${probe.query.slice(0, 77)}...` : probe.query}`;
  const target = probe.table ? `${probe.table}.${probe.name}` : probe.name;
  return `${probe.kind} ${target}${probe.expectedPresent ? "" : " (absent)"}`;
}

/**
 * For each migration, the object probes that a later migration in the list
 * declares again, mapped to that later migration's id.
 */
export function supersededObjectProbes(
  migrations: MigrationDefinition[],
): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();
  const declaredLater = new Map<string, string>();
  for (const migration of [...migrations].sort((a, b) => b.id.localeCompare(a.id))) {
    const keys = deriveCatalogProbes(migration)
      .filter((probe): probe is CatalogObjectProbe => !("query" in probe))
      .map(catalogObjectKey);
    const superseded = new Map<string, string>();
    for (const key of keys) {
      const by = declaredLater.get(key);
      if (by) superseded.set(key, by);
    }
    result.set(migration.id, superseded);
    for (const key of keys) declaredLater.set(key, migration.id);
  }
  return result;
}

/**
 * Adoption view of a catalog report. An object that must be absent is also
 * absent before the migration ever ran, so absence probes only count once the
 * objects the file creates exist; extension prerequisites and probes that a
 * later migration supersedes never count.
 */
export function adoptionCatalogState(
  report: MigrationCatalogReport,
  superseded: ReadonlyMap<string, string> = new Map(),
): {
  state: AdoptionCatalogState;
  matched: number;
  total: number;
  failed: string[];
  superseded: string[];
} {
  const isSuperseded = (probe: Probe): boolean => !("query" in probe) && superseded.has(catalogObjectKey(probe));
  const supersededProbes = report.probes
    .filter(({ probe }) => isSuperseded(probe))
    .map(({ probe }) => `${describeProbe(probe)} (declared again by ${superseded.get(catalogObjectKey(probe as CatalogObjectProbe))})`);
  const relevant = report.probes.filter(({ probe }) => !isPrerequisiteProbe(probe) && !isSuperseded(probe));
  const positive = relevant.filter(({ probe }) => !isAbsenceProbe(probe));
  const absence = relevant.filter(({ probe }) => isAbsenceProbe(probe));
  const failed = relevant.filter(({ passed }) => !passed).map(({ probe }) => describeProbe(probe));
  const matched = relevant.length - failed.length;
  const total = relevant.length;
  let state: AdoptionCatalogState;
  if (total === 0) state = "unverifiable";
  else if (positive.length === 0) state = matched === total ? "all" : matched === 0 ? "none" : "partial";
  else {
    const positivePassed = positive.filter(({ passed }) => passed).length;
    if (positivePassed === 0) state = "none";
    else if (positivePassed === positive.length && absence.every(({ passed }) => passed)) state = "all";
    else state = "partial";
  }
  return { state, matched, total, failed, superseded: supersededProbes };
}

export interface AdoptionDecisionInput {
  migration: MigrationDefinition;
  catalog: AdoptionCatalogState;
  legacy: LegacyNetworkingState;
  /** True when `_prisma_migrations` has finished migrations and no failed ones. */
  prismaBaseline: boolean;
}

export interface AdoptionDecision {
  classification?: AdoptionClassification;
  abort?: string;
  carriedSteps: number[];
}

/** The plan's decision rules for one migration. Pure; unit tested. */
export function decideAdoption(input: AdoptionDecisionInput): AdoptionDecision {
  const { migration, catalog, legacy } = input;
  const idempotent = migration.directives.idempotent;
  const abort = (reason: string): AdoptionDecision => ({ abort: `${migration.id}: ${reason}`, carriedSteps: [] });
  const byProbes = (): AdoptionDecision => {
    switch (catalog) {
      case "all":
        return { classification: "applied", carriedSteps: [] };
      case "none":
        return { classification: "pending", carriedSteps: [] };
      case "partial":
        return idempotent
          ? { classification: "pending", carriedSteps: [] }
          : abort("catalog probes partially match a non-idempotent migration");
      case "unverifiable":
        return idempotent
          ? { classification: "pending", carriedSteps: [] }
          : abort("no catalog probes or legacy record can show whether this non-idempotent migration ran");
    }
  };

  if (legacy.kind === "invalid") return abort(legacy.reason);

  if (migration.id === "0000" && input.prismaBaseline) {
    return catalog === "all"
      ? { classification: "baseline", carriedSteps: [] }
      : abort("_prisma_migrations records a Prisma-managed schema, but the 0000 catalog probes do not all match");
  }

  switch (legacy.kind) {
    case "untracked":
      return byProbes();
    case "applied":
      return catalog === "all" || catalog === "unverifiable"
        ? { classification: "applied", carriedSteps: legacy.steps }
        : abort(`networking_migrations records ${legacy.name} as applied, but its catalog probes do not all match`);
    case "absent":
      if (catalog === "all") {
        return abort(`its objects exist, but networking_migrations has no record of ${legacy.name}`);
      }
      return byProbes();
    case "steps":
      if (catalog === "none") {
        return abort(`networking_migrations records steps of ${legacy.name}, but none of its objects exist`);
      }
      if (!idempotent) return abort("legacy step rows exist for a non-idempotent migration");
      // Resume: `apply` skips the carried steps and runs the rest (guarded SQL).
      return { classification: "pending", carriedSteps: legacy.steps };
  }
}
