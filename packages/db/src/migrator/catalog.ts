import type { Client, QueryResultRow } from "pg";
import type { DatabaseEngine, MigrationDefinition } from "./migration";
import type {
  CatalogObjectKind,
  CatalogObjectProbe,
  CatalogSqlProbe,
  MigrationCatalogReport,
} from "./types";

function stripComments(sql: string): string {
  return sql.replace(/--[^\r\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

const IDENTIFIER = '(?:"((?:[^"]|"")+)"|([a-zA-Z_][a-zA-Z0-9_$]*))';
const QUALIFIED_IDENTIFIER = `(?:${IDENTIFIER}\\s*\\.\\s*)?${IDENTIFIER}`;

function identifierValue(match: RegExpExecArray, index: number): string {
  return (match[index] ?? match[index + 1] ?? "").replace(/""/g, '"');
}

function objectName(match: RegExpExecArray, qualifiedStart: number): string {
  return identifierValue(match, qualifiedStart + 2);
}

function findProbe(
  migration: MigrationDefinition,
  statementIndex: number,
  kind: CatalogObjectKind,
  name: string,
  options: { table?: string; expectedPresent?: boolean; source?: CatalogObjectProbe["source"] } = {},
): CatalogObjectProbe {
  return {
    migrationId: migration.id,
    variant: migration.variant,
    statementIndex,
    kind,
    name,
    ...(options.table ? { table: options.table } : {}),
    expectedPresent: options.expectedPresent ?? true,
    source: options.source ?? "ddl",
  };
}

/**
 * These original networking files are single per-file execution steps so
 * their legacy file checksums stay fixed. Keep complete catalog metadata here
 * instead of adding breakpoints to those historical SQL bodies.
 */
const HISTORICAL_MULTI_STATEMENT_OBJECTS: Record<
  string,
  Array<{
    kind: CatalogObjectKind;
    name: string;
    table?: string;
    expectedPresent?: boolean;
  }>
> = {
  "0001:shared": [
    { kind: "index", name: "email_template_registration_uniq", table: "email_templates" },
    { kind: "index", name: "email_template_abstract_uniq", table: "email_templates" },
    { kind: "index", name: "abstracts_event_id_author_email_normalized_key", table: "abstracts" },
    { kind: "index", name: "email_logs_registration_trigger_active_key", table: "email_logs" },
    { kind: "index", name: "email_logs_abstract_submission_ack_active_key", table: "email_logs" },
    { kind: "index", name: "email_logs_template_recipient_trigger_active_key", table: "email_logs" },
    { kind: "index", name: "outbox_events_dedupe_key_key", table: "outbox_events" },
    { kind: "index", name: "registrations_access_type_ids_inverted_idx", table: "registrations" },
  ],
  "0003:shared": [
    { kind: "column", name: "dedupe_key", table: "email_logs" },
    { kind: "index", name: "email_logs_dedupe_key_active_key", table: "email_logs" },
  ],
  "0005:shared": [
    { kind: "column", name: "scope", table: "certificate_templates" },
    { kind: "constraint", name: "certificate_templates_scope_check", table: "certificate_templates" },
    { kind: "column", name: "allowed_abstract_final_types", table: "certificate_templates" },
  ],
  "0007:shared": [
    { kind: "column", name: "success_translations", table: "forms" },
    { kind: "column", name: "translations", table: "abstract_themes" },
    { kind: "column", name: "languages", table: "abstract_config" },
  ],
  "0015:shared": [
    { kind: "column", name: "second_factor_verified_at", table: "networking_sessions" },
    { kind: "table", name: "networking_second_factors" },
  ],
  "0016:shared": [
    { kind: "index", name: "networking_blocks_target_profile_idx", table: "networking_blocks" },
    { kind: "index", name: "networking_connections_reverse_pair_idx", table: "networking_connections" },
    { kind: "index", name: "networking_profiles_embedding_scan_idx", table: "networking_profiles" },
  ],
  "0018:shared": [
    { kind: "table", name: "networking_spaces" },
    { kind: "index", name: "networking_spaces_event_name_key", table: "networking_spaces" },
    { kind: "column", name: "space_id", table: "networking_tables" },
    { kind: "constraint", name: "networking_tables_two_people_check", table: "networking_tables" },
    { kind: "index", name: "networking_tables_event_name_key", table: "networking_tables", expectedPresent: false },
    { kind: "index", name: "networking_tables_space_name_key", table: "networking_tables" },
    { kind: "index", name: "networking_tables_event_space_idx", table: "networking_tables" },
    { kind: "index", name: "networking_profiles_stand_idx", table: "networking_profiles" },
  ],
  "0019:shared": [
    { kind: "column", name: "cancellation_note", table: "networking_meetings" },
    { kind: "index", name: "networking_messages_sender_created_idx", table: "networking_messages" },
    { kind: "index", name: "networking_notifications_unread_idx", table: "networking_notifications" },
    { kind: "index", name: "networking_meetings_requester_start_idx", table: "networking_meetings" },
    { kind: "index", name: "networking_meetings_recipient_start_idx", table: "networking_meetings" },
  ],
  "0013:shared": [
    { kind: "table", name: "networking_embeddings" },
    { kind: "index", name: "networking_embeddings_profile_kind_model_key", table: "networking_embeddings" },
    { kind: "index", name: "networking_embeddings_event_kind_model_idx", table: "networking_embeddings" },
    { kind: "table", name: "networking_embedding_jobs" },
    { kind: "index", name: "networking_embedding_jobs_pending_idx", table: "networking_embedding_jobs" },
  ],
};

/** Identity of a catalog object across migrations (indexes are schema-wide). */
export function catalogObjectKey(probe: CatalogObjectProbe): string {
  if (probe.kind === "index") return `${probe.kind}:${probe.name}`;
  return `${probe.kind}:${probe.table ?? ""}:${probe.name}`;
}

function probesForStatement(
  migration: MigrationDefinition,
  statement: string,
  statementIndex: number,
): CatalogObjectProbe[] {
  const sql = stripComments(statement).trim();
  const probes: CatalogObjectProbe[] = [];
  let match: RegExpExecArray | null;

  match = new RegExp(`^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${QUALIFIED_IDENTIFIER}`, "i").exec(sql);
  if (match) {
    probes.push(findProbe(migration, statementIndex, "table", objectName(match, 1)));
    return probes;
  }

  match = new RegExp(`^CREATE\\s+TYPE\\s+${QUALIFIED_IDENTIFIER}`, "i").exec(sql);
  if (match) {
    probes.push(findProbe(migration, statementIndex, "type", objectName(match, 1)));
    return probes;
  }

  match = new RegExp(`^CREATE\\s+(?:VECTOR\\s+)?(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENTIFIER}\\s+ON\\s+${QUALIFIED_IDENTIFIER}`, "i").exec(sql);
  if (match) {
    probes.push(findProbe(migration, statementIndex, "index", identifierValue(match, 1), { table: objectName(match, 3) }));
    return probes;
  }

  match = new RegExp(`^DROP\\s+INDEX\\s+(?:IF\\s+EXISTS\\s+)?${QUALIFIED_IDENTIFIER}`, "i").exec(sql);
  if (match) {
    probes.push(findProbe(migration, statementIndex, "index", objectName(match, 1), { expectedPresent: false }));
    return probes;
  }

  match = new RegExp(`^ALTER\\s+TABLE\\s+${QUALIFIED_IDENTIFIER}\\s+ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENTIFIER}`, "i").exec(sql);
  if (match) {
    probes.push(findProbe(migration, statementIndex, "column", identifierValue(match, 5), { table: objectName(match, 1) }));
    return probes;
  }

  match = new RegExp(`^ALTER\\s+TABLE\\s+${QUALIFIED_IDENTIFIER}\\s+ADD\\s+CONSTRAINT\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENTIFIER}`, "i").exec(sql);
  if (match) {
    probes.push(findProbe(migration, statementIndex, "constraint", identifierValue(match, 5), { table: objectName(match, 1) }));
  }
  return probes;
}

export function deriveCatalogProbes(migration: MigrationDefinition): Array<CatalogObjectProbe | CatalogSqlProbe> {
  const objects = new Map<string, CatalogObjectProbe>();
  const sqlProbes: CatalogSqlProbe[] = [];
  migration.statements.forEach((statement, index) => {
    for (const probe of probesForStatement(migration, statement, index)) {
      objects.set(catalogObjectKey(probe), probe);
    }
  });
  for (const object of HISTORICAL_MULTI_STATEMENT_OBJECTS[`${migration.id}:${migration.variant}`] ?? []) {
    const probe = findProbe(migration, 0, object.kind, object.name, { ...object, source: "manifest" });
    objects.set(catalogObjectKey(probe), probe);
  }
  for (const extension of migration.directives.requiresExtensions) {
    const probe: CatalogObjectProbe = {
      migrationId: migration.id,
      variant: migration.variant,
      statementIndex: -1,
      kind: "extension",
      name: extension,
      expectedPresent: true,
      source: "directive",
    };
    objects.set(catalogObjectKey(probe), probe);
  }
  for (const query of migration.directives.verify) {
    sqlProbes.push({ migrationId: migration.id, variant: migration.variant, query, source: "verify" });
  }
  return [...objects.values(), ...sqlProbes];
}

/**
 * Final schema verification checks the last declared state of each object.
 * A later migration may intentionally remove an index introduced earlier.
 * Per-migration probe sets remain available to adoption through
 * deriveCatalogProbes/inspectMigrationCatalog.
 */
export function deriveEffectiveCatalogProbes(
  migrations: MigrationDefinition[],
): Map<string, Array<CatalogObjectProbe | CatalogSqlProbe>> {
  const finalObjects = new Map<string, CatalogObjectProbe>();
  const sqlByMigration = new Map<string, CatalogSqlProbe[]>();
  for (const migration of migrations) {
    for (const probe of deriveCatalogProbes(migration)) {
      if ("query" in probe) {
        const current = sqlByMigration.get(migration.id) ?? [];
        current.push(probe);
        sqlByMigration.set(migration.id, current);
      } else {
        finalObjects.set(catalogObjectKey(probe), probe);
      }
    }
  }

  const grouped = new Map<string, Array<CatalogObjectProbe | CatalogSqlProbe>>();
  for (const probe of finalObjects.values()) {
    const current = grouped.get(probe.migrationId) ?? [];
    current.push(probe);
    grouped.set(probe.migrationId, current);
  }
  for (const [migrationId, probes] of sqlByMigration) {
    const current = grouped.get(migrationId) ?? [];
    current.push(...probes);
    grouped.set(migrationId, current);
  }
  return grouped;
}

async function objectExists(
  client: Client,
  engine: DatabaseEngine,
  probe: CatalogObjectProbe,
): Promise<boolean> {
  if (probe.kind === "extension" && engine === "cockroach") return true;
  let result: { rows: Array<{ present: boolean }> };
  switch (probe.kind) {
    case "table":
      result = await client.query<{ present: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = $1 AND table_type = 'BASE TABLE'
        ) AS present`,
        [probe.name],
      );
      break;
    case "column":
      result = await client.query<{ present: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
        ) AS present`,
        [probe.table, probe.name],
      );
      break;
    case "index":
      result = await client.query<{ present: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_indexes
          WHERE schemaname = 'public' AND indexname = $1
            AND ($2::text IS NULL OR tablename = $2)
        ) AS present`,
        [probe.name, probe.table ?? null],
      );
      break;
    case "constraint":
      result = await client.query<{ present: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = 'public' AND table_name = $1 AND constraint_name = $2
        ) AS present`,
        [probe.table, probe.name],
      );
      break;
    case "type":
      result = await client.query<{ present: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_type t
          JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'public' AND t.typname = $1
        ) AS present`,
        [probe.name],
      );
      break;
    case "extension":
      result = await client.query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = $1) AS present`,
        [probe.name],
      );
      break;
  }
  const present = Boolean(result.rows[0]?.present);
  return probe.expectedPresent ? present : !present;
}

async function sqlProbe(client: Client, probe: CatalogSqlProbe): Promise<boolean> {
  const result = await client.query<QueryResultRow>(probe.query);
  if (!result.rows.length) return false;
  const firstRow = result.rows[0];
  const firstValue = firstRow[Object.keys(firstRow)[0] ?? ""];
  return firstValue === true || firstValue === "true" || firstValue === 1;
}

export async function inspectMigrationCatalog(
  client: Client,
  engine: DatabaseEngine,
  migration: MigrationDefinition,
): Promise<MigrationCatalogReport> {
  return inspectCatalogProbes(client, engine, migration, deriveCatalogProbes(migration));
}

export async function inspectCatalogProbes(
  client: Client,
  engine: DatabaseEngine,
  migration: MigrationDefinition,
  probes: Array<CatalogObjectProbe | CatalogSqlProbe>,
): Promise<MigrationCatalogReport> {
  const results: Array<{ probe: CatalogObjectProbe | CatalogSqlProbe; passed: boolean }> = [];
  for (const probe of probes) {
    const passed = "query" in probe
      ? await sqlProbe(client, probe)
      : await objectExists(client, engine, probe);
    results.push({ probe, passed });
  }
  const matched = results.filter((result) => result.passed).length;
  const total = results.length;
  const state = total === 0 ? "unverifiable" : matched === total ? "all" : matched === 0 ? "none" : "partial";
  return { migrationId: migration.id, variant: migration.variant, matched, total, state, probes: results };
}
