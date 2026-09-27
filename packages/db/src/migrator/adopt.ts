import { tableExists } from "./catalog-read";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import {
  legacyEvidence,
  mapLegacyNetworkingRows,
  type LegacyNetworkingRow,
} from "./legacy-networking";
import {
  adoptionCatalogState,
  decideAdoption,
  supersededObjectProbes,
  type AdoptionDecision,
} from "./adopt-rules";
import type { DatabaseEngine, MigrationDefinition } from "./migration";
import {
  acquireMigrationLease,
  assertLeaseAlive,
  releaseMigrationLease,
  runLeaseFencedTransaction,
  startLeaseHeartbeat,
  type LeaseHeartbeat,
} from "./lease";
import { schemaHasApplicationObjects } from "./ledger";
import { setUtcSession } from "./session";
import { redactCredentials } from "./security";
import type {
  AdoptionAssessment,
  MigrationAdoptionOptions,
  MigrationAdoptionReport,
  MigrationAdoptionSupport,
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
 * would look partially migrated for the earlier one (`supersededObjectProbes`
 * in ./adopt-rules).
 */

// Re-exported so existing imports from ./adopt keep working.
export {
  type AdoptionCatalogState,
  describeProbe,
  supersededObjectProbes,
  adoptionCatalogState,
  type AdoptionDecisionInput,
  type AdoptionDecision,
  decideAdoption,
} from "./adopt-rules";
export {
  type LegacyNetworkingRow,
  type LegacyNetworkingState,
  legacyTracking,
  mapLegacyNetworkingRows,
} from "./legacy-networking";
export { formatAdoptionReport } from "./adopt-report";

export interface LegacyEvidence {
  /** Null when the `networking_migrations` table does not exist. */
  networkingRows: LegacyNetworkingRow[] | null;
  /** Null when `_prisma_migrations` does not exist. */
  prisma: { finished: number; failed: number; latest: string | null } | null;
  schemaMigrationRows: number;
  hasApplicationObjects: boolean;
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

export async function adoptMigrations(
  client: Client,
  engine: DatabaseEngine,
  migrations: MigrationDefinition[],
  options: MigrationAdoptionOptions,
  support: MigrationAdoptionSupport,
): Promise<MigrationAdoptionReport> {
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
}
