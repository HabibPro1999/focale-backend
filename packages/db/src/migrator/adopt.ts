import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { catalogObjectKey, deriveCatalogProbes } from "./catalog";
import {
  LEGACY_NETWORKING_0018_CROSSWALK,
  LEGACY_NETWORKING_FILE_CHECKSUMS,
  crosswalkLegacyNetworking0018Steps,
  type LegacyNetworking0018StepRow,
} from "./legacy-networking";
import type { DatabaseEngine, MigrationDefinition } from "./migration";
import {
  acquireMigrationLease,
  assertLeaseAlive,
  releaseMigrationLease,
  runLeaseFencedTransaction,
  schemaHasApplicationObjects,
  setUtcSession,
  startLeaseHeartbeat,
  type LeaseHeartbeat,
} from "./runner";
import { redactCredentials } from "./security";
import type {
  AdoptionAssessment,
  AdoptionClassification,
  CatalogObjectProbe,
  CatalogSqlProbe,
  MigrationAdoptionOptions,
  MigrationAdoptionReport,
  MigrationAdoptionSupport,
  MigrationAdoptionWorkflow,
  MigrationCatalogReport,
} from "./types";

/*
 * `migrate adopt` classifies every known migration of an existing database that
 * has no unified ledger, from three kinds of evidence:
 *   - the old `networking_migrations` ledger (file checksums; CockroachDB 0018
 *     step rows through the fixed crosswalk),
 *   - `_prisma_migrations` (records 0000 as `baseline`),
 *   - catalog probes derived from each file's DDL and `verify` directives.
 * All probes pass → applied; none → pending; partial on an idempotent file →
 * pending; partial on a non-idempotent file, or a legacy ledger that disagrees
 * with the probes → abort with nothing written. `--apply` writes ledger rows
 * only, under the same lease as `apply`; it never executes migration SQL.
 *
 * An object that a later migration declares again (for example 0018 dropping
 * the `networking_tables_event_name_key` index that 0012 creates) is judged by
 * that later migration only; otherwise every database that ran the later file
 * would look partially migrated for the earlier one.
 */

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

export interface LegacyNetworkingRow {
  name: string;
  checksum: string;
}

export interface LegacyEvidence {
  /** Null when the `networking_migrations` table does not exist. */
  networkingRows: LegacyNetworkingRow[] | null;
  /** Null when `_prisma_migrations` does not exist. */
  prisma: { finished: number; failed: number; latest: string | null } | null;
  schemaMigrationRows: number;
  hasApplicationObjects: boolean;
}

export type LegacyNetworkingState =
  | { kind: "untracked" }
  | { kind: "absent"; name: string }
  | { kind: "applied"; name: string; checksum: string; steps: number[] }
  | { kind: "steps"; name: string; steps: number[] }
  | { kind: "invalid"; name: string; reason: string };

interface LegacyTracking {
  name: string;
  checksum: string;
}

/** Where the old migrate-networking.mjs recorded this migration, if at all. */
export function legacyTracking(migration: MigrationDefinition): LegacyTracking | undefined {
  const checksums: Record<string, string> = LEGACY_NETWORKING_FILE_CHECKSUMS;
  if (migration.variant === "cockroach" && migration.id === LEGACY_NETWORKING_0018_CROSSWALK.id) {
    // The old runner stepped through the shared file and recorded its name.
    return {
      name: LEGACY_NETWORKING_0018_CROSSWALK.legacyName,
      checksum: LEGACY_NETWORKING_0018_CROSSWALK.legacyFileChecksum,
    };
  }
  const checksum = checksums[`${migration.id}:${migration.variant}`];
  if (!checksum) return undefined;
  return {
    name: migration.variant === "cockroach" ? `cockroach/${migration.name}` : migration.name,
    checksum,
  };
}

const STEP_NAME = /^(?:cockroach\/)?(.+\.sql):step:\d+$/;

/**
 * Map legacy networking rows onto the loaded migrations. Rows that no known
 * migration explains are returned so adoption can refuse them.
 */
export function mapLegacyNetworkingRows(
  migrations: MigrationDefinition[],
  rows: LegacyNetworkingRow[] | null,
): { states: Map<string, LegacyNetworkingState>; unknown: string[] } {
  const states = new Map<string, LegacyNetworkingState>();
  if (rows === null) {
    for (const migration of migrations) states.set(migration.id, { kind: "untracked" });
    return { states, unknown: [] };
  }
  const consumed = new Set<string>();
  for (const migration of migrations) {
    const tracking = legacyTracking(migration);
    if (!tracking) {
      states.set(migration.id, { kind: "untracked" });
      continue;
    }
    const fileRow = rows.find((row) => row.name === tracking.name);
    const stepRows = rows.filter((row) => STEP_NAME.exec(row.name)?.[1] === tracking.name);
    if (fileRow) consumed.add(fileRow.name);
    for (const row of stepRows) consumed.add(row.name);
    states.set(migration.id, legacyStateFor(migration, tracking, fileRow, stepRows));
  }
  const unknown = rows.filter((row) => !consumed.has(row.name)).map((row) => row.name);
  return { states, unknown };
}

function legacyStateFor(
  migration: MigrationDefinition,
  tracking: LegacyTracking,
  fileRow: LegacyNetworkingRow | undefined,
  stepRows: LegacyNetworking0018StepRow[],
): LegacyNetworkingState {
  const name = tracking.name;
  if (fileRow && fileRow.checksum !== tracking.checksum) {
    return { kind: "invalid", name, reason: `networking_migrations checksum for ${name} does not match the known historical file` };
  }
  const stepped = migration.variant === "cockroach" && migration.id === LEGACY_NETWORKING_0018_CROSSWALK.id;
  if (!stepped) {
    if (stepRows.length) {
      return { kind: "invalid", name, reason: `networking_migrations has unexpected step rows for ${name}` };
    }
    return fileRow ? { kind: "applied", name, checksum: fileRow.checksum, steps: [] } : { kind: "absent", name };
  }
  if (!fileRow && stepRows.length === 0) return { kind: "absent", name };
  let steps: number[];
  try {
    steps = crosswalkLegacyNetworking0018Steps(migration, fileRow?.checksum, stepRows).map((step) => step.stepIndex);
  } catch (error) {
    return { kind: "invalid", name, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!fileRow) return { kind: "steps", name, steps };
  // The old runner wrote the file row only after every step row.
  if (steps.length !== LEGACY_NETWORKING_0018_CROSSWALK.steps.length) {
    return { kind: "invalid", name, reason: `networking_migrations records ${name} as applied without all of its step rows` };
  }
  return { kind: "applied", name, checksum: fileRow.checksum, steps };
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

async function tableExists(client: Client, name: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    ) AS present`,
    [name],
  );
  return Boolean(result.rows[0]?.present);
}

export async function readLegacyEvidence(client: Client): Promise<LegacyEvidence> {
  const networkingRows = (await tableExists(client, "networking_migrations"))
    ? (await client.query<LegacyNetworkingRow>(
        "SELECT name, checksum FROM public.networking_migrations ORDER BY name",
      )).rows
    : null;
  let prisma: LegacyEvidence["prisma"] = null;
  if (await tableExists(client, "_prisma_migrations")) {
    const row = (await client.query<{ finished: string | number | null; failed: string | number | null; latest: string | null }>(
      `SELECT
         sum(CASE WHEN finished_at IS NOT NULL AND rolled_back_at IS NULL THEN 1 ELSE 0 END) AS finished,
         sum(CASE WHEN finished_at IS NULL AND rolled_back_at IS NULL THEN 1 ELSE 0 END) AS failed,
         max(CASE WHEN finished_at IS NOT NULL AND rolled_back_at IS NULL THEN migration_name END) AS latest
       FROM public."_prisma_migrations"`,
    )).rows[0];
    prisma = { finished: Number(row?.finished ?? 0), failed: Number(row?.failed ?? 0), latest: row?.latest ?? null };
  }
  const schemaMigrationRows = (await tableExists(client, "schema_migrations"))
    ? Number((await client.query<{ n: string | number }>("SELECT count(*) AS n FROM public.schema_migrations")).rows[0]?.n ?? 0)
    : 0;
  return {
    networkingRows,
    prisma,
    schemaMigrationRows,
    hasApplicationObjects: await schemaHasApplicationObjects(client),
  };
}

function legacyEvidence(state: LegacyNetworkingState): Record<string, unknown> | undefined {
  switch (state.kind) {
    case "untracked":
      return undefined;
    case "absent":
      return { name: state.name, recorded: false };
    case "applied":
      return { name: state.name, recorded: true, checksum: state.checksum, ...(state.steps.length ? { steps: state.steps } : {}) };
    case "steps":
      return { name: state.name, recorded: "steps-only", steps: state.steps };
    case "invalid":
      return { name: state.name, invalid: state.reason };
  }
}

/** Classify every migration without writing anything. */
export async function assessAdoption(
  client: Client,
  migrations: MigrationDefinition[],
  support: MigrationAdoptionSupport,
  engine: DatabaseEngine,
): Promise<Pick<MigrationAdoptionReport, "assessments" | "warnings" | "errors">> {
  const evidence = await readLegacyEvidence(client);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (evidence.schemaMigrationRows > 0) {
    errors.push(
      `schema_migrations already has ${evidence.schemaMigrationRows} row(s); adopt only applies to databases without a ledger (use status/verify)`,
    );
  }
  if (evidence.prisma && evidence.prisma.failed > 0) {
    errors.push(`_prisma_migrations has ${evidence.prisma.failed} unfinished migration(s); resolve them before adopting`);
  }
  if (evidence.prisma && evidence.prisma.finished === 0 && evidence.prisma.failed === 0) {
    warnings.push("_prisma_migrations exists but records no finished migration; 0000 is classified by probes only");
  }
  const prismaBaseline = Boolean(evidence.prisma && evidence.prisma.finished > 0 && evidence.prisma.failed === 0);
  const { states, unknown } = mapLegacyNetworkingRows(migrations, evidence.networkingRows);
  const superseded = supersededObjectProbes(migrations);
  for (const name of unknown) errors.push(`networking_migrations contains ${name}, which no known migration explains`);

  const assessments: AdoptionAssessment[] = [];
  for (const migration of migrations) {
    let catalog: MigrationCatalogReport;
    try {
      catalog = await support.catalog.inspect(client, engine, migration);
    } catch (error) {
      const message = redactCredentials(error instanceof Error ? error.message : String(error));
      catalog = { migrationId: migration.id, variant: migration.variant, matched: 0, total: 0, state: "unverifiable", probes: [] };
      assessments.push({
        migration,
        abort: `${migration.id}: catalog probe failed (${message})`,
        evidence: { source: "adopt", catalogError: message },
        catalog,
        carriedSteps: [],
      });
      continue;
    }
    const view = adoptionCatalogState(catalog, superseded.get(migration.id));
    const legacy = states.get(migration.id) ?? { kind: "untracked" as const };
    const decision: AdoptionDecision = evidence.hasApplicationObjects
      ? decideAdoption({ migration, catalog: view.state, legacy, prismaBaseline })
      : { classification: "pending", carriedSteps: [] };
    const legacyDetails = legacyEvidence(legacy);
    assessments.push({
      migration,
      ...(decision.classification ? { classification: decision.classification } : {}),
      ...(decision.abort ? { abort: decision.abort } : {}),
      evidence: {
        source: "adopt",
        catalog: {
          state: view.state,
          matched: view.matched,
          total: view.total,
          ...(view.failed.length ? { failed: view.failed.slice(0, 20) } : {}),
          ...(view.superseded.length ? { superseded: view.superseded } : {}),
        },
        ...(legacyDetails ? { legacyNetworking: legacyDetails } : {}),
        ...(migration.id === "0000" && evidence.prisma ? { prisma: { finished: evidence.prisma.finished, latest: evidence.prisma.latest } } : {}),
        ...(decision.carriedSteps.length ? { carriedSteps: decision.carriedSteps } : {}),
      },
      catalog,
      carriedSteps: decision.carriedSteps,
    });
  }

  if (!evidence.hasApplicationObjects) {
    warnings.push("The database has no application objects; nothing to adopt. Use `apply` on an empty database.");
  } else {
    for (const assessment of assessments) {
      if (assessment.classification === "pending" && assessment.catalog.total === 0) {
        warnings.push(`${assessment.migration.id} has no catalog probes; apply will run it again (declared idempotent)`);
      }
      if (assessment.classification === "pending" && assessment.migration.directives.deferrable) {
        warnings.push(`${assessment.migration.id} is deferrable; apply evaluates its defer-unless condition`);
      }
    }
    const lastAdopted = assessments.reduce(
      (last, assessment, index) =>
        assessment.classification === "applied" || assessment.classification === "baseline" ? index : last,
      -1,
    );
    const outOfOrder = assessments
      .slice(0, lastAdopted)
      .filter((assessment) => assessment.classification === "pending")
      .map((assessment) => assessment.migration.id);
    if (outOfOrder.length) {
      warnings.push(`Pending ${outOfOrder.join(", ")} precede migrations already present; apply will run them after those`);
    }
  }
  for (const assessment of assessments) if (assessment.abort) errors.push(assessment.abort);
  return { assessments, warnings, errors };
}

function rowsToWrite(assessments: AdoptionAssessment[]): { migrations: number; steps: number } {
  return {
    migrations: assessments.filter((a) => a.classification === "applied" || a.classification === "baseline").length,
    steps: assessments.reduce((total, a) => total + a.carriedSteps.length, 0),
  };
}

/**
 * Write every adoption row in one lease-fenced transaction. A heartbeat renewal
 * that commits while it is open fails the fence with 40001 on CockroachDB; the
 * transaction is rolled back and written again (runLeaseFencedTransaction).
 */
async function writeAdoptionLedger(
  client: Client,
  assessments: AdoptionAssessment[],
  options: MigrationAdoptionOptions,
  support: MigrationAdoptionSupport,
  owner: string,
  heartbeat: LeaseHeartbeat | undefined,
): Promise<void> {
  await runLeaseFencedTransaction(client, owner, heartbeat, async () => {
    await assertLeaseAlive(client, owner, heartbeat);
    for (const assessment of assessments) {
      for (const stepIndex of assessment.carriedSteps) {
        await support.ledger.writeStep(client, assessment.migration, stepIndex, options.appliedBy);
      }
      if (assessment.classification === "applied" || assessment.classification === "baseline") {
        await support.ledger.writeMigration(
          client,
          assessment.migration,
          assessment.classification,
          options.appliedBy,
          assessment.evidence,
        );
      }
    }
  });
}

export const migrationAdoptionWorkflow: MigrationAdoptionWorkflow = {
  async run(client, engine, migrations, options, support): Promise<MigrationAdoptionReport> {
    await setUtcSession(client);
    const first = await assessAdoption(client, migrations, support, engine);
    const report = (assessed: typeof first, written = { migrations: 0, steps: 0 }): MigrationAdoptionReport => ({
      engine,
      ...assessed,
      aborted: assessed.errors.length > 0,
      written,
    });
    const planned = rowsToWrite(first.assessments);
    if (!options.writeLedger || first.errors.length || planned.migrations + planned.steps === 0) {
      return report(first);
    }

    await support.ledger.ensureSchema(client);
    const owner = `adopt:${process.pid}:${randomUUID()}`;
    await acquireMigrationLease(client, owner);
    let heartbeat: LeaseHeartbeat | undefined;
    try {
      if (options.leaseConnectionString) {
        heartbeat = await startLeaseHeartbeat(options.leaseConnectionString, owner);
      }
      // Evidence may have changed before the lease was held; decide again.
      const confirmed = await assessAdoption(client, migrations, support, engine);
      if (confirmed.errors.length) return report(confirmed);
      await writeAdoptionLedger(client, confirmed.assessments, options, support, owner, heartbeat);
      return report(confirmed, rowsToWrite(confirmed.assessments));
    } finally {
      await heartbeat?.close().catch(() => undefined);
      await releaseMigrationLease(client, owner).catch(() => undefined);
    }
  },
};

/** Human-readable adoption report; every line is credential-redacted. */
export function formatAdoptionReport(report: MigrationAdoptionReport, writeLedger: boolean): string[] {
  const lines: string[] = [];
  const mode = writeLedger ? "apply" : "dry run (no changes)";
  lines.push(`Migration adoption (${report.engine}; ${mode}):`);
  for (const assessment of report.assessments) {
    const verdict = assessment.abort ? "ABORT" : assessment.classification ?? "?";
    const catalog = assessment.evidence.catalog as { state: string; matched: number; total: number; failed?: string[] } | undefined;
    const parts: string[] = [];
    if (catalog) parts.push(`probes ${catalog.matched}/${catalog.total} (${catalog.state})`);
    const legacy = assessment.evidence.legacyNetworking as { name: string; recorded?: unknown; invalid?: string } | undefined;
    if (legacy) {
      parts.push(
        legacy.invalid
          ? `networking_migrations invalid`
          : `networking_migrations ${legacy.recorded === true ? "recorded" : legacy.recorded === "steps-only" ? "steps only" : "no record"}`,
      );
    }
    const prisma = assessment.evidence.prisma as { finished: number; latest: string | null } | undefined;
    if (prisma) parts.push(`_prisma_migrations ${prisma.finished} finished${prisma.latest ? ` (latest ${prisma.latest})` : ""}`);
    if (assessment.carriedSteps.length) parts.push(`legacy steps ${assessment.carriedSteps.join(",")} carried`);
    lines.push(`  ${assessment.migration.id} ${verdict.padEnd(8)} [${assessment.migration.variant}] ${parts.join("; ")}`);
    if (catalog?.failed?.length && (assessment.abort || catalog.state === "partial")) {
      for (const failed of catalog.failed) lines.push(`         missing: ${failed}`);
    }
  }
  for (const warning of report.warnings) lines.push(`warning: ${warning}`);
  for (const error of report.errors) lines.push(`error: ${error}`);
  if (report.aborted) lines.push("Adoption aborted; nothing was written.");
  else if (writeLedger) lines.push(`Wrote ${report.written.migrations} migration record(s) and ${report.written.steps} step record(s).`);
  else lines.push("Dry run only; re-run with --apply to write these ledger rows.");
  return lines.map(redactCredentials);
}
