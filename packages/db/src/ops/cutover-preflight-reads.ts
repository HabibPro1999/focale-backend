import type { Client } from "pg";
import { tableExists } from "../migrator/catalog-read";
import type { MigrationDefinition } from "../migrator/migration";
import type { PreflightRow } from "./cutover-preflight-checks";

/*
 * Operational reads of the cutover preflight (everything except the
 * per-migration data checks). Plain SELECTs and SHOWs; the caller runs each
 * one inside the read-only transaction under its own savepoint.
 */

/** CockroachDB settings the migrator and the Nest services depend on. */
export const COCKROACH_SETTINGS = ["version", "feature.vector_index.enabled", "sql.txn.read_committed_isolation.enabled"] as const;

export interface SettingValue {
  value?: unknown;
  /** Why it could not be read, e.g. the user lacks VIEWCLUSTERSETTING. */
  error?: string;
}

export async function clusterSetting(client: Client, name: (typeof COCKROACH_SETTINGS)[number]): Promise<unknown> {
  const result = await client.query(`SHOW CLUSTER SETTING ${name}`);
  return Object.values(result.rows[0] ?? {})[0];
}

export async function listPublicTables(client: Client): Promise<string[]> {
  const result = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );
  return result.rows.map((row) => row.table_name);
}

export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export async function countRows(client: Client, table: string): Promise<number> {
  const result = await client.query<{ n: number | string }>(`SELECT count(*) AS n FROM public.${quoteIdentifier(table)}`);
  return Number(result.rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Foreign-key names. 0000_init.sql declares Drizzle names
// (`users_client_id_clients_id_fk`); a Prisma-built production schema has
// `<table>_<columns>_fkey`. The adopt verdict decides what that means; this
// summary only shows which convention the database uses.

export interface DeclaredForeignKey {
  migrationId: string;
  table: string;
  name: string;
  columns: string[];
}

const FOREIGN_KEY_DECLARATION =
  /ALTER\s+TABLE\s+(?:"?public"?\s*\.\s*)?"?([A-Za-z_][\w$]*)"?\s+ADD\s+CONSTRAINT\s+"?([A-Za-z_][\w$]*)"?\s+FOREIGN\s+KEY\s*\(([^)]*)\)/gi;

/** Named foreign keys each migration adds with `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY`. */
export function declaredForeignKeys(migrations: MigrationDefinition[]): DeclaredForeignKey[] {
  const declared: DeclaredForeignKey[] = [];
  for (const migration of migrations) {
    const sql = migration.source.replace(/--[^\r\n]*/g, " ");
    for (const match of sql.matchAll(FOREIGN_KEY_DECLARATION)) {
      declared.push({
        migrationId: migration.id,
        table: match[1],
        name: match[2],
        columns: match[3].split(",").map((column) => column.trim().replace(/^"|"$/g, "")),
      });
    }
  }
  return declared;
}

/** Prisma's default foreign-key name. */
export function prismaForeignKeyName(table: string, columns: string[]): string {
  return `${table}_${columns.join("_")}_fkey`;
}

export interface ForeignKeySummary {
  total: number;
  prismaNamed: number;
  drizzleNamed: number;
  otherNamed: number;
  byMigration: Array<{
    migrationId: string;
    declared: number;
    byDeclaredName: number;
    byPrismaName: number;
    /** Declared names with neither the declared nor the Prisma name present. */
    missing: string[];
  }>;
}

export function summarizeForeignKeys(
  present: Array<{ table_name: string; constraint_name: string }>,
  declared: DeclaredForeignKey[],
): ForeignKeySummary {
  const names = new Set(present.map((row) => `${row.table_name}\u0000${row.constraint_name}`));
  const has = (table: string, name: string) => names.has(`${table}\u0000${name}`);
  const byMigration = new Map<string, ForeignKeySummary["byMigration"][number]>();
  for (const key of declared) {
    const entry = byMigration.get(key.migrationId)
      ?? { migrationId: key.migrationId, declared: 0, byDeclaredName: 0, byPrismaName: 0, missing: [] };
    entry.declared += 1;
    if (has(key.table, key.name)) entry.byDeclaredName += 1;
    else if (has(key.table, prismaForeignKeyName(key.table, key.columns))) entry.byPrismaName += 1;
    else entry.missing.push(key.name);
    byMigration.set(key.migrationId, entry);
  }
  const prismaNamed = present.filter((row) => row.constraint_name.endsWith("_fkey")).length;
  const drizzleNamed = present.filter((row) => row.constraint_name.endsWith("_fk")).length;
  return {
    total: present.length,
    prismaNamed,
    drizzleNamed,
    otherNamed: present.length - prismaNamed - drizzleNamed,
    byMigration: [...byMigration.values()],
  };
}

export async function foreignKeySummary(client: Client, migrations: MigrationDefinition[]): Promise<ForeignKeySummary> {
  const present = await client.query<{ table_name: string; constraint_name: string }>(
    `SELECT table_name, constraint_name FROM information_schema.table_constraints
     WHERE constraint_schema = 'public' AND constraint_type = 'FOREIGN KEY'
     ORDER BY table_name, constraint_name`,
  );
  return summarizeForeignKeys(present.rows, declaredForeignKeys(migrations));
}

// ---------------------------------------------------------------------------
// Queues. A row a worker has claimed (SENDING, PROCESSING, RUNNING) is in
// flight; legacy workers must be stopped and these drained before the Nest
// worker starts. Waiting rows (QUEUED, PENDING, FAILED outbox) are picked up
// by the Nest worker. Same predicates as the readiness report's drain query.

export interface QueueState {
  table: string;
  counts: Record<string, number>;
  inFlight: number;
}

const QUEUES: Array<{ table: string; statuses: string[]; inFlight: string[] }> = [
  { table: "email_logs", statuses: ["QUEUED", "SENDING"], inFlight: ["SENDING"] },
  { table: "outbox_events", statuses: ["PENDING", "PROCESSING", "FAILED"], inFlight: ["PROCESSING"] },
  { table: "abstract_book_jobs", statuses: ["PENDING", "RUNNING"], inFlight: ["RUNNING"] },
];

export async function queueStates(client: Client): Promise<QueueState[]> {
  const states: QueueState[] = [];
  for (const queue of QUEUES) {
    if (!(await tableExists(client, queue.table))) continue;
    const list = queue.statuses.map((status) => `'${status}'`).join(", ");
    const result = await client.query<{ status: string; n: number | string }>(
      `SELECT status::text AS status, count(*) AS n FROM ${queue.table} WHERE status::text IN (${list}) GROUP BY 1 ORDER BY 1`,
    );
    const counts = Object.fromEntries(queue.statuses.map((status) => [status, 0]));
    for (const row of result.rows) counts[row.status] = Number(row.n);
    states.push({ table: queue.table, counts, inFlight: queue.inFlight.reduce((sum, status) => sum + counts[status], 0) });
  }
  return states;
}

export async function emailStatusCounts(client: Client): Promise<Record<string, number>> {
  if (!(await tableExists(client, "email_logs"))) return {};
  const result = await client.query<{ status: string; n: number | string }>(
    "SELECT status::text AS status, count(*) AS n FROM email_logs GROUP BY 1 ORDER BY 1",
  );
  return Object.fromEntries(result.rows.map((row) => [row.status, Number(row.n)]));
}

// ---------------------------------------------------------------------------
// Public link origins: every origin recently stored in link_base_url must be
// in PUBLIC_LINK_ALLOWED_ORIGINS, or the Nest API rejects public registrations
// and abstract submissions from it. Lower-cased before matching so HTTPS://
// and https:// count as one origin; an unparseable value has origin null.

export interface LinkOrigin {
  origin: string | null;
  count: number;
  lastSeen: unknown;
}

export async function linkOrigins(client: Client, table: "registrations" | "abstracts"): Promise<LinkOrigin[]> {
  if (!(await tableExists(client, table))) return [];
  const result = await client.query<{ origin: string | null; n: number | string; last_seen: unknown }>(
    `SELECT substring(lower(link_base_url) from '^https?://[^/?#]+') AS origin, count(*) AS n, max(created_at) AS last_seen
     FROM ${table} WHERE link_base_url IS NOT NULL
     GROUP BY 1 ORDER BY max(created_at) DESC`,
  );
  return result.rows.map((row) => ({ origin: row.origin, count: Number(row.n), lastSeen: row.last_seen }));
}

// Readiness report (PRODUCTION_READINESS_2026-10-30.md) section 5 item 12:
// legacy did not hold sponsor-covered seats in paid_count while VERIFYING;
// Nest does, so these rows need a paid_count reconciliation by hand.
const SPONSORED_VERIFYING = `
SELECT r.id FROM registrations r
WHERE r.payment_status::text = 'VERIFYING'
  AND EXISTS (
    SELECT 1 FROM sponsorship_usages su JOIN sponsorships s ON s.id = su.sponsorship_id
    WHERE su.registration_id = r.id AND cardinality(s.covered_access_ids) > 0)
ORDER BY r.id`;

export async function sponsoredVerifying(client: Client): Promise<{ count: number; registrationIds: unknown[] }> {
  const result = await client.query<PreflightRow>(SPONSORED_VERIFYING);
  return { count: result.rows.length, registrationIds: result.rows.map((row) => row.id) };
}
