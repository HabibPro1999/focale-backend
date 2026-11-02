import { drizzle } from "drizzle-orm/node-postgres";
import type { Client } from "pg";
import { loadMigrations } from "../migrator/migration";
import {
  applyMigrations,
  databaseEngine,
  listMigrationRecords,
  migrationLedgerExists,
  normalizeAppliedBy,
  setUtcSession,
} from "../migrator/runner";
import {
  NETWORKING_VECTOR_INDEX,
  networkingVectorIndexStatus,
  type NetworkingVectorIndexStatus,
} from "../queries/networking-vector-search";

/** The migration that creates the CockroachDB vector index; deferred while embeddings exist. */
export const NETWORKING_VECTOR_INDEX_MIGRATION = "0017";

export interface NetworkingVectorIndexReport extends NetworkingVectorIndexStatus {
  /** Ledger state of 0017 on CockroachDB: applied, deferred, pending or no-ledger. */
  migration: string;
  /** CockroachDB `feature.vector_index.enabled`; null when unreadable (needs admin privileges) or PostgreSQL. */
  featureEnabled: boolean | null;
  embeddingRows: number;
}

async function featureEnabled(client: Client): Promise<boolean | null> {
  try {
    const result = await client.query("SHOW CLUSTER SETTING feature.vector_index.enabled");
    return Object.values(result.rows[0] ?? {}).some((value) => value === true || value === "true" || value === "on");
  } catch {
    return null;
  }
}

/** Read-only: everything an operator needs before and after building the index. */
export async function networkingVectorIndexReport(client: Client): Promise<NetworkingVectorIndexReport> {
  await setUtcSession(client);
  const status = await networkingVectorIndexStatus({ db: drizzle(client) });
  const ledger = (await migrationLedgerExists(client)) ? await listMigrationRecords(client) : null;
  const record = ledger?.find((row) => row.id === NETWORKING_VECTOR_INDEX_MIGRATION);
  const rows = await client.query<{ count: string | number }>("SELECT count(*) AS count FROM networking_embeddings");
  return {
    ...status,
    migration: status.engine === "postgres" ? "not-applicable" : !ledger ? "no-ledger" : record?.status ?? "pending",
    featureEnabled: status.engine === "cockroach" ? await featureEnabled(client) : null,
    embeddingRows: Number(rows.rows[0]?.count ?? 0),
  };
}

export function formatNetworkingVectorIndexReport(report: NetworkingVectorIndexReport): string[] {
  return [
    `engine: ${report.engine}`,
    `ANN index: ${report.present ? "present" : "missing"}${report.engine === "cockroach" ? ` (${NETWORKING_VECTOR_INDEX})` : ""}`,
    `migration ${NETWORKING_VECTOR_INDEX_MIGRATION}: ${report.migration}`,
    `feature.vector_index.enabled: ${report.featureEnabled === null ? "n/a or unreadable" : report.featureEnabled}`,
    `embedding rows: ${report.embeddingRows}`,
    `events above ${report.threshold} embedded profiles: ${report.eventsAboveThreshold}`,
    `recommendations: ${report.fallbackActive ? "deterministic profile rules for those events (index missing)" : "vector ranking"}`,
  ];
}

/**
 * Why the index cannot be built now, or null when `build` may proceed. The
 * index is built only through the migration ledger (apply-deferred 0017), so
 * `verify` and later `apply` runs keep agreeing with the schema.
 */
export function networkingVectorIndexBuildBlocker(report: NetworkingVectorIndexReport): string | null {
  if (report.engine !== "cockroach")
    return "PostgreSQL has no ANN index migration; events above the exact limit keep the deterministic fallback";
  if (report.present) return `${NETWORKING_VECTOR_INDEX} already exists; nothing to build`;
  if (report.migration === "no-ledger") return "No migration ledger: adopt the database first (migrator adopt)";
  if (report.migration === "pending")
    return `Migration ${NETWORKING_VECTOR_INDEX_MIGRATION} is still pending: run migrator apply --yes first (it records it as deferred or applies it)`;
  if (report.migration !== "deferred")
    return `Migration ${NETWORKING_VECTOR_INDEX_MIGRATION} is recorded as ${report.migration} but the index is missing: run migrator verify --schema and investigate before rebuilding`;
  if (report.featureEnabled === false)
    return "Enable it first as a database administrator: SET CLUSTER SETTING feature.vector_index.enabled = true";
  return null;
}

/**
 * Builds the index by applying the deferred 0017 through the migrator (lease,
 * ledger, fence). Writes to networking_embeddings block until the backfill
 * finishes, so run it in a maintenance window with the worker stopped.
 */
export async function buildNetworkingVectorIndex(
  client: Client,
  options: { connectionString: string; migrationsDirectory: string; appliedBy?: string; onStart?: () => void },
): Promise<{ before: NetworkingVectorIndexReport; after: NetworkingVectorIndexReport; durationMs: number }> {
  const before = await networkingVectorIndexReport(client);
  const blocker = networkingVectorIndexBuildBlocker(before);
  if (blocker) throw new Error(blocker);
  const engine = await databaseEngine(client);
  // The runner needs every migration it knows (later ledger rows would be "unknown");
  // `through` below limits what it applies.
  const migrations = await loadMigrations(options.migrationsDirectory, engine);
  // Build only 0017: anything earlier still pending belongs to a normal `apply`.
  const recorded = new Set((await listMigrationRecords(client)).map((record) => record.id));
  const pending = migrations.filter((migration) =>
    migration.id < NETWORKING_VECTOR_INDEX_MIGRATION && !recorded.has(migration.id));
  if (pending.length)
    throw new Error(`Migrations ${pending.map((migration) => migration.id).join(", ")} are pending: run migrator apply --yes first`);
  options.onStart?.();
  const started = Date.now();
  const result = await applyMigrations(client, migrations, {
    through: NETWORKING_VECTOR_INDEX_MIGRATION,
    applyDeferred: NETWORKING_VECTOR_INDEX_MIGRATION,
    appliedBy: normalizeAppliedBy(options.appliedBy ?? "networking-vector-index"),
    leaseConnectionString: options.connectionString,
  });
  const durationMs = Date.now() - started;
  if (!result.applied.includes(NETWORKING_VECTOR_INDEX_MIGRATION))
    throw new Error(`Migration ${NETWORKING_VECTOR_INDEX_MIGRATION} was not applied (applied: ${result.applied.join(", ") || "none"})`);
  const after = await networkingVectorIndexReport(client);
  if (!after.present) throw new Error(`${NETWORKING_VECTOR_INDEX} is still missing after the build`);
  return { before, after, durationMs };
}
