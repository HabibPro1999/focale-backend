import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, types, type CustomTypesConfig } from "pg";
import { adoptMigrations } from "../migrator/adopt";
import { formatAdoptionReport } from "../migrator/adopt-report";
import { listMigrationRecords, migrationAdoptionSupport, migrationLedgerExists } from "../migrator/ledger";
import { loadMigrations, type DatabaseEngine, type MigrationDefinition } from "../migrator/migration";
import { redactCredentials } from "../migrator/security";
import { detectDatabaseEngine, setUtcSession } from "../migrator/session";
import type { MigrationAdoptionSupport } from "../migrator/types";
import { DATA_CHECKS, type DataCheckStatus, type PreflightRow } from "./cutover-preflight-checks";
import {
  COCKROACH_SETTINGS,
  clusterSetting,
  countRows,
  emailStatusCounts,
  foreignKeySummary,
  linkOrigins,
  listPublicTables,
  queueStates,
  quoteIdentifier,
  sponsoredVerifying,
  type ForeignKeySummary,
  type LinkOrigin,
  type QueueState,
  type SettingValue,
} from "./cutover-preflight-reads";
import {
  PERSONAL_DATA_NOTICE,
  formatCutoverPreflightMarkdown,
  preflightFindings,
  type PreflightFinding,
} from "./cutover-preflight-report";

/*
 * Read-only cutover preflight and postflight (production rollout).
 *
 * `preflight` proves, before `adopt`/`apply` run on production, what each
 * migration will do to existing data, and exports every row a data-changing
 * migration modifies so the pre-change values are kept outside the database.
 * `postflight` recounts every table after the cutover and fails when a table
 * lost rows or vanished (except abstract_code_sequences, which 0033 drops).
 *
 * Every query runs in one read-only transaction (snapshot) on a dedicated
 * connection whose session default is read-only as well: on CockroachDB a DDL
 * statement inside an explicit READ ONLY transaction autocommits that
 * transaction and runs outside it (`autocommit_before_ddl`), which the session
 * default still refuses. A write probe proves the refusal before anything
 * else runs, and the transaction always ends with ROLLBACK.
 */

/** Tables a migration of this build drops on purpose; their rows are exported by the preflight. */
export const TABLE_DROP_EXCEPTIONS: Record<string, string> = {
  abstract_code_sequences:
    "dropped by 0033_drop_abstract_code_sequences.sql; the preflight exported its rows to affected/0033.json",
};

const RETRY_ATTEMPTS = 3;

// Timestamps keep the database's own text (a JS Date drops microseconds and
// reads timestamp without time zone in local time); int8 values (counts, and
// every INTEGER column on CockroachDB) become numbers when they are exact.
const PREFLIGHT_TYPES: CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: string) => {
    if (oid === types.builtins.TIMESTAMP || oid === types.builtins.TIMESTAMPTZ || oid === types.builtins.DATE) {
      return (value: string) => value;
    }
    if (oid === types.builtins.INT8) {
      return (value: string) => (Number.isSafeInteger(Number(value)) ? Number(value) : value);
    }
    return types.getTypeParser(oid, format as "text");
  }) as CustomTypesConfig["getTypeParser"],
};

export interface DataCheckEntry {
  migrationId: string;
  file: string;
  effect: string;
  /** file:line of each predicate the check mirrors. */
  source: string[];
  status: DataCheckStatus;
  /** Ledger state: applied, baseline, deferred, pending, or no-ledger. */
  ledger: string;
  /** Adopt dry-run verdict when the database has no ledger yet. */
  adopt?: string;
  summary: string;
  affectedRows: number;
  /** Relative path of the export, e.g. affected/0011.json. */
  export?: string;
  review?: boolean;
  details?: Record<string, unknown>;
  error?: string;
}

export interface AdoptDryRun {
  ran: boolean;
  /** Why it did not run (a database that already has a ledger). */
  skipped?: string;
  aborted?: boolean;
  errors?: string[];
  warnings?: string[];
  verdicts?: Array<{ id: string; variant: string; verdict: string; abort?: string; evidence: Record<string, unknown> }>;
  /** The migrator's own `adopt` dry-run output. */
  lines?: string[];
}

export interface MigrationOverview {
  id: string;
  name: string;
  variant: string;
  ledger: string;
  adopt?: string;
  /**
   * Tables whose existing rows the SQL updates, deletes, retypes or drops, with
   * their current row count (null: the table does not exist).
   */
  modifies: Array<{ table: string; rows: number | null }>;
  /** Status of its dedicated data check, when it has one. */
  check?: DataCheckStatus;
}

export interface CutoverPreflightReport {
  kind: "cutover-preflight";
  formatVersion: 1;
  generatedAt: string;
  notice: string;
  database: { engine: DatabaseEngine; version: string; name: string; settings: Record<string, SettingValue> };
  session: {
    readOnly: boolean;
    isolation: string;
    writeProbe: { table: string; sqlstate: string } | { skipped: string };
    attempts: number;
  };
  ledger: {
    present: boolean;
    records: Array<{ id: string; status: string; variant: string }>;
    pending: string[];
    unknown: string[];
  };
  adopt: AdoptDryRun;
  foreignKeys: ForeignKeySummary | null;
  migrations: MigrationOverview[];
  dataChecks: DataCheckEntry[];
  queues: QueueState[] | null;
  emailStatusCounts: Record<string, number> | null;
  linkOrigins: { registrations: LinkOrigin[] | null; abstracts: LinkOrigin[] | null };
  sponsoredVerifying: { count: number; registrationIds: unknown[] } | null;
  tableCounts: { file: string; tables: number; rows: number; errors: Record<string, string> };
  /** Sections that could not be read. */
  errors: Array<{ section: string; message: string }>;
  findings: PreflightFinding[];
}

export interface TableCountsFile {
  kind: "cutover-table-counts";
  formatVersion: 1;
  generatedAt: string;
  engine: DatabaseEngine;
  database: string;
  tables: Record<string, number>;
  /** Tables whose count failed, with the reason. */
  errors?: Record<string, string>;
}

export interface AffectedRowsFile {
  kind: "cutover-preflight-affected-rows";
  formatVersion: 1;
  notice: string;
  generatedAt: string;
  migrationId: string;
  file: string;
  effect: string;
  status: DataCheckStatus;
  summary: string;
  rows: PreflightRow[];
  related?: Record<string, PreflightRow[]>;
}

export interface CutoverPreflightResult {
  report: CutoverPreflightReport;
  tableCounts: TableCountsFile;
  affected: AffectedRowsFile[];
}

function messageOf(error: unknown): string {
  return redactCredentials(error instanceof Error ? error.message : String(error));
}

/** SQLSTATE of a pg error, or the code of a Node.js system error. */
function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

/** A CockroachDB transaction retry error: the whole read-only transaction is run again. */
function isRetryable(error: unknown): boolean {
  return errorCode(error) === "40001";
}

async function openReadOnlyClient(connectionString: string): Promise<Client> {
  const client = new Client({ connectionString, types: PREFLIGHT_TYPES, application_name: "cutover-preflight" });
  await client.connect();
  try {
    // Session default first: every implicit and explicit transaction on this
    // connection is read-only from here on.
    await client.query("SET default_transaction_read_only = on");
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  return client;
}

function beginStatement(engine: DatabaseEngine): { sql: string; isolation: string } {
  // PostgreSQL: REPEATABLE READ gives one snapshot and never fails a read-only
  // transaction with a serialization error. CockroachDB: SERIALIZABLE (its
  // snapshot level, whatever the session default) at low priority, so
  // production writers win any contention.
  return engine === "cockroach"
    ? { sql: "BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE, PRIORITY LOW, READ ONLY", isolation: "serializable, priority low" }
    : { sql: "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY", isolation: "repeatable read" };
}

let savepointCounter = 0;

/** Run `operation` under a savepoint so an error does not abort the snapshot transaction. */
async function isolated<T>(client: Client, operation: () => Promise<T>): Promise<T> {
  savepointCounter += 1;
  const name = `cutover_preflight_${savepointCounter}`;
  await client.query(`SAVEPOINT ${name}`);
  try {
    const value = await operation();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return value;
  } catch (error) {
    // A retry error invalidates the transaction; the caller starts it again.
    if (!isRetryable(error)) await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    throw error;
  }
}

/**
 * Run `collect` inside one read-only transaction, after proving the session
 * refuses writes; always rolled back. Retried from the start on a CockroachDB
 * retry error.
 */
async function inReadOnlySnapshot<T>(
  client: Client,
  engine: DatabaseEngine,
  collect: (session: CutoverPreflightReport["session"]) => Promise<T>,
): Promise<T> {
  const begin = beginStatement(engine);
  for (let attempt = 1; ; attempt += 1) {
    await client.query(begin.sql);
    try {
      const readOnly = await client.query("SHOW transaction_read_only");
      const value = Object.values(readOnly.rows[0] ?? {})[0];
      if (value !== "on" && value !== true) throw new Error("The preflight transaction is not read-only; stopping before any other query");
      await setUtcSession(client);
      const writeProbe = await proveWritesRefused(client);
      return await collect({ readOnly: true, isolation: begin.isolation, writeProbe, attempts: attempt });
    } catch (error) {
      if (isRetryable(error) && attempt < RETRY_ATTEMPTS) continue;
      throw error;
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
    }
  }
}

/**
 * Attempt a delete that matches no row and expect SQLSTATE 25006
 * (read_only_sql_transaction). Even if read-only enforcement were broken, it
 * would change nothing; the preflight then stops.
 */
async function proveWritesRefused(client: Client): Promise<CutoverPreflightReport["session"]["writeProbe"]> {
  const [table] = await listPublicTables(client);
  if (!table) return { skipped: "the public schema has no table to probe" };
  try {
    await isolated(client, () => client.query(`DELETE FROM public.${quoteIdentifier(table)} WHERE false`));
  } catch (error) {
    if (errorCode(error) === "25006") return { table, sqlstate: "25006" };
    throw error;
  }
  throw new Error("A write was not refused inside the preflight transaction; stopping");
}

async function readLedger(client: Client, migrations: MigrationDefinition[]): Promise<CutoverPreflightReport["ledger"]> {
  if (!(await migrationLedgerExists(client))) return { present: false, records: [], pending: migrations.map((m) => m.id), unknown: [] };
  const records = await listMigrationRecords(client);
  const recorded = new Set(records.map((record) => record.id));
  const known = new Set(migrations.map((migration) => migration.id));
  return {
    present: true,
    records: records.map((record) => ({ id: record.id, status: record.status, variant: record.variant })),
    pending: migrations.filter((migration) => !recorded.has(migration.id)).map((migration) => migration.id),
    unknown: records.filter((record) => !known.has(record.id)).map((record) => record.id),
  };
}

/**
 * The migrator's own adopt planner in dry-run mode (writeLedger: false never
 * takes the lease or writes). Catalog probes run under savepoints so one
 * failing probe is reported by adopt instead of aborting the snapshot.
 */
async function adoptDryRun(
  client: Client,
  engine: DatabaseEngine,
  migrations: MigrationDefinition[],
  ledger: CutoverPreflightReport["ledger"],
): Promise<AdoptDryRun> {
  if (ledger.records.length) {
    return { ran: false, skipped: `the ledger already records ${ledger.records.length} migration(s); adopt applies only to a database without one` };
  }
  const support: MigrationAdoptionSupport = {
    ...migrationAdoptionSupport,
    catalog: {
      inspect: (session, probeEngine, migration) =>
        isolated(session, () => migrationAdoptionSupport.catalog.inspect(session, probeEngine, migration)),
    },
  };
  const report = await adoptMigrations(client, engine, migrations, { writeLedger: false, appliedBy: "cutover-preflight" }, support);
  return {
    ran: true,
    aborted: report.aborted,
    errors: report.errors.map(redactCredentials),
    warnings: report.warnings.map(redactCredentials),
    verdicts: report.assessments.map((assessment) => ({
      id: assessment.migration.id,
      variant: assessment.migration.variant,
      verdict: assessment.abort ? "abort" : assessment.classification ?? "unknown",
      ...(assessment.abort ? { abort: redactCredentials(assessment.abort) } : {}),
      evidence: assessment.evidence,
    })),
    lines: formatAdoptionReport(report, false),
  };
}

const TABLE_NAME = String.raw`(?:"?public"?\s*\.\s*)?"?([A-Za-z_][\w$]*)"?`;
const MODIFYING_STATEMENTS = [
  new RegExp(String.raw`^\s*UPDATE\s+(?:ONLY\s+)?(?!SET\b)${TABLE_NAME}`, "gim"),
  new RegExp(String.raw`^\s*DELETE\s+FROM\s+(?:ONLY\s+)?${TABLE_NAME}`, "gim"),
  new RegExp(String.raw`^\s*TRUNCATE\s+(?:TABLE\s+)?${TABLE_NAME}`, "gim"),
  new RegExp(String.raw`^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${TABLE_NAME}`, "gim"),
  new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?${TABLE_NAME}\s+ALTER\s+COLUMN\s+"?[\w$]+"?\s+(?:SET\s+DATA\s+)?TYPE\b`, "gi"),
];

/**
 * Tables whose existing rows a migration's SQL updates, deletes, retypes or
 * drops (comments ignored). INSERTs only add rows and are not listed.
 */
export function modifiedTables(migration: Pick<MigrationDefinition, "source">): string[] {
  const sql = migration.source.replace(/--[^\r\n]*/g, " ");
  const tables = new Set<string>();
  for (const pattern of MODIFYING_STATEMENTS) for (const match of sql.matchAll(pattern)) tables.add(match[1]);
  return [...tables];
}

/** Ledger state of one migration: its recorded status, pending, or no-ledger. */
function ledgerState(ledger: CutoverPreflightReport["ledger"], id: string): string {
  if (!ledger.present) return "no-ledger";
  return ledger.records.find((record) => record.id === id)?.status ?? "pending";
}

async function runDataChecks(
  client: Client,
  migrations: MigrationDefinition[],
  ledger: CutoverPreflightReport["ledger"],
  adopt: AdoptDryRun,
  generatedAt: string,
): Promise<{ entries: DataCheckEntry[]; affected: AffectedRowsFile[] }> {
  const entries: DataCheckEntry[] = [];
  const affected: AffectedRowsFile[] = [];
  for (const check of DATA_CHECKS) {
    const migration = migrations.find((candidate) => candidate.id === check.migrationId);
    const state = ledgerState(ledger, check.migrationId);
    const verdict = adopt.verdicts?.find((entry) => entry.id === check.migrationId)?.verdict;
    const base = {
      migrationId: check.migrationId,
      file: check.file,
      effect: check.effect,
      source: check.citations.map((citation) => `${check.file}:${citation.line}`),
      ledger: state,
      ...(verdict ? { adopt: verdict } : {}),
    };
    if (state === "applied" || state === "baseline") {
      entries.push({ ...base, status: "skipped", summary: `the ledger records it as ${state}; apply will not run it`, affectedRows: 0 });
      continue;
    }
    if (!migration) {
      entries.push({ ...base, status: "error", summary: "not part of this build", affectedRows: 0, error: "migration file not found" });
      continue;
    }
    try {
      const result = await isolated(client, () =>
        check.run({ client, migration, isolated: (operation) => isolated(client, operation) }));
      const exported = result.status !== "not-applicable";
      if (exported) {
        affected.push({
          kind: "cutover-preflight-affected-rows",
          formatVersion: 1,
          notice: PERSONAL_DATA_NOTICE,
          generatedAt,
          migrationId: check.migrationId,
          file: check.file,
          effect: check.effect,
          status: result.status,
          summary: result.summary,
          rows: result.rows,
          ...(result.related ? { related: result.related } : {}),
        });
      }
      entries.push({
        ...base,
        status: result.status,
        summary: result.summary,
        affectedRows: result.rows.length,
        ...(exported ? { export: `affected/${check.migrationId}.json` } : {}),
        ...(result.review ? { review: true } : {}),
        ...(result.details ? { details: result.details } : {}),
      });
    } catch (error) {
      if (isRetryable(error)) throw error;
      entries.push({ ...base, status: "error", summary: "the check could not run", affectedRows: 0, error: messageOf(error) });
    }
  }
  return { entries, affected };
}

async function countTables(
  client: Client,
  tables: string[],
): Promise<{ counts: Record<string, number>; errors: Record<string, string> }> {
  const counts: Record<string, number> = {};
  const errors: Record<string, string> = {};
  for (const table of tables) {
    try {
      counts[table] = await isolated(client, () => countRows(client, table));
    } catch (error) {
      if (isRetryable(error)) throw error;
      errors[table] = messageOf(error);
    }
  }
  return { counts, errors };
}

async function identify(client: Client): Promise<{ engine: DatabaseEngine; version: string; name: string }> {
  const result = await client.query<{ version: string; name: string }>("SELECT version() AS version, current_database() AS name");
  const version = result.rows[0]?.version ?? "";
  return { engine: detectDatabaseEngine(version), version, name: result.rows[0]?.name ?? "" };
}

/** Collect the preflight on a connection already opened read-only (openReadOnlyClient). */
async function collectPreflight(client: Client, migrationsDirectory: string): Promise<CutoverPreflightResult> {
  const identity = await identify(client);
  const migrations = await loadMigrations(migrationsDirectory, identity.engine);
  return inReadOnlySnapshot(client, identity.engine, async (session) => {
    const generatedAt = new Date().toISOString();
    const errors: CutoverPreflightReport["errors"] = [];
    async function section<T>(name: string, read: () => Promise<T>, fallback: T): Promise<T> {
      try {
        return await isolated(client, read);
      } catch (error) {
        if (isRetryable(error)) throw error;
        errors.push({ section: name, message: messageOf(error) });
        return fallback;
      }
    }

    const settings: Record<string, SettingValue> = {};
    if (identity.engine === "cockroach") {
      for (const name of COCKROACH_SETTINGS) {
        try {
          settings[name] = { value: await isolated(client, () => clusterSetting(client, name)) };
        } catch (error) {
          if (isRetryable(error)) throw error;
          settings[name] = { error: messageOf(error) };
        }
      }
    }
    const ledger = await section("ledger", () => readLedger(client, migrations), null);
    if (!ledger) throw new Error(`Could not read the migration ledger: ${errors.at(-1)?.message ?? "unknown error"}`);
    const adopt = await section<AdoptDryRun>("adopt", () => adoptDryRun(client, identity.engine, migrations, ledger), { ran: false, skipped: "the adopt dry run failed; see errors" });
    const foreignKeys = await section("foreignKeys", () => foreignKeySummary(client, migrations), null);
    const checks = await runDataChecks(client, migrations, ledger, adopt, generatedAt);
    const queues = await section("queues", () => queueStates(client), null);
    const emailStatuses = await section("emailStatusCounts", () => emailStatusCounts(client), null);
    const registrationOrigins = await section("linkOrigins.registrations", () => linkOrigins(client, "registrations"), null);
    const abstractOrigins = await section("linkOrigins.abstracts", () => linkOrigins(client, "abstracts"), null);
    const verifying = await section("sponsoredVerifying", () => sponsoredVerifying(client), null);
    const tables = await isolated(client, () => listPublicTables(client));
    const counted = await countTables(client, tables);

    const migrationsOverview: MigrationOverview[] = migrations.map((migration) => {
      const verdict = adopt.verdicts?.find((entry) => entry.id === migration.id)?.verdict;
      const check = checks.entries.find((entry) => entry.migrationId === migration.id)?.status;
      return {
        id: migration.id,
        name: migration.name,
        variant: migration.variant,
        ledger: ledgerState(ledger, migration.id),
        ...(verdict ? { adopt: verdict } : {}),
        modifies: modifiedTables(migration).map((table) => ({ table, rows: counted.counts[table] ?? null })),
        ...(check ? { check } : {}),
      };
    });
    const report: CutoverPreflightReport = {
      kind: "cutover-preflight",
      formatVersion: 1,
      generatedAt,
      notice: PERSONAL_DATA_NOTICE,
      database: { ...identity, settings },
      session,
      ledger,
      adopt,
      foreignKeys,
      migrations: migrationsOverview,
      dataChecks: checks.entries,
      queues,
      emailStatusCounts: emailStatuses,
      linkOrigins: { registrations: registrationOrigins, abstracts: abstractOrigins },
      sponsoredVerifying: verifying,
      tableCounts: {
        file: "table-counts.json",
        tables: Object.keys(counted.counts).length,
        rows: Object.values(counted.counts).reduce((sum, count) => sum + count, 0),
        errors: counted.errors,
      },
      errors,
      findings: [],
    };
    report.findings = preflightFindings(report);
    const tableCounts: TableCountsFile = {
      kind: "cutover-table-counts",
      formatVersion: 1,
      generatedAt,
      engine: identity.engine,
      database: identity.name,
      tables: counted.counts,
      ...(Object.keys(counted.errors).length ? { errors: counted.errors } : {}),
    };
    return { report, tableCounts, affected: checks.affected };
  });
}

/** Read-only preflight on its own connection; nothing is written to the database. */
export async function runCutoverPreflight(options: {
  connectionString: string;
  migrationsDirectory: string;
}): Promise<CutoverPreflightResult> {
  const client = await openReadOnlyClient(options.connectionString);
  try {
    return await collectPreflight(client, options.migrationsDirectory);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Recount every table in one read-only transaction on its own connection. */
export async function collectTableCounts(connectionString: string): Promise<TableCountsFile> {
  const client = await openReadOnlyClient(connectionString);
  try {
    const identity = await identify(client);
    return await inReadOnlySnapshot(client, identity.engine, async () => {
      const counted = await countTables(client, await listPublicTables(client));
      return {
        kind: "cutover-table-counts",
        formatVersion: 1,
        generatedAt: new Date().toISOString(),
        engine: identity.engine,
        database: identity.name,
        tables: counted.counts,
        ...(Object.keys(counted.errors).length ? { errors: counted.errors } : {}),
      };
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Postflight comparison.

export interface TableCountComparison {
  ok: boolean;
  lost: Array<{ table: string; before: number; after: number }>;
  vanished: Array<{ table: string; before: number }>;
  /** Vanished tables a migration drops on purpose (TABLE_DROP_EXCEPTIONS). */
  exempt: Array<{ table: string; before: number; reason: string }>;
  added: Array<{ table: string; after: number }>;
  grown: Array<{ table: string; before: number; after: number }>;
  unchanged: number;
  /** Tables that could not be counted on either side; the comparison cannot prove them. */
  uncounted: Array<{ table: string; reason: string }>;
  warnings: string[];
}

export function compareTableCounts(baseline: TableCountsFile, current: TableCountsFile): TableCountComparison {
  const comparison: TableCountComparison = {
    ok: true, lost: [], vanished: [], exempt: [], added: [], grown: [], unchanged: 0, uncounted: [], warnings: [],
  };
  if (baseline.engine !== current.engine) comparison.warnings.push(`baseline engine ${baseline.engine}, current ${current.engine}`);
  if (baseline.database !== current.database) {
    comparison.warnings.push(`baseline database "${baseline.database}", current "${current.database}"`);
  }
  const currentTables = new Set([...Object.keys(current.tables), ...Object.keys(current.errors ?? {})]);
  for (const [table, reason] of Object.entries(baseline.errors ?? {})) {
    comparison.uncounted.push({ table, reason: `not counted in the baseline: ${reason}` });
  }
  for (const [table, before] of Object.entries(baseline.tables)) {
    if (!currentTables.has(table)) {
      const reason = TABLE_DROP_EXCEPTIONS[table];
      if (reason) comparison.exempt.push({ table, before, reason });
      else comparison.vanished.push({ table, before });
      continue;
    }
    const after = current.tables[table];
    if (after === undefined) {
      comparison.uncounted.push({ table, reason: current.errors?.[table] ?? "not counted" });
    } else if (after < before) {
      comparison.lost.push({ table, before, after });
    } else if (after > before) {
      comparison.grown.push({ table, before, after });
    } else {
      comparison.unchanged += 1;
    }
  }
  const known = new Set([...Object.keys(baseline.tables), ...Object.keys(baseline.errors ?? {})]);
  for (const [table, after] of Object.entries(current.tables)) if (!known.has(table)) comparison.added.push({ table, after });
  for (const [table, reason] of Object.entries(current.errors ?? {})) {
    if (!known.has(table)) comparison.uncounted.push({ table, reason });
  }
  comparison.ok = !comparison.lost.length && !comparison.vanished.length && !comparison.uncounted.length;
  return comparison;
}

export function parseTableCountsFile(text: string): TableCountsFile {
  const parsed = JSON.parse(text) as Partial<TableCountsFile>;
  if (parsed.kind !== "cutover-table-counts" || parsed.formatVersion !== 1 || typeof parsed.tables !== "object" || !parsed.tables) {
    throw new Error("The baseline is not a table-counts.json written by cutover-preflight preflight");
  }
  for (const [table, count] of Object.entries(parsed.tables)) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error(`The baseline count for ${table} is not a row count`);
  }
  return parsed as TableCountsFile;
}

// ---------------------------------------------------------------------------
// Output files.

/** Create `directory` (mode 0700) or accept an existing empty one; never overwrite. */
async function prepareOutputDirectory(directory: string): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  if (entries.length) throw new Error(`Refusing to write into ${directory}: it is not empty (keep each run's files apart)`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}

/** Write report.json, report.md, table-counts.json and affected/<migrationId>.json. */
export async function writeCutoverPreflight(directory: string, result: CutoverPreflightResult): Promise<string[]> {
  await prepareOutputDirectory(directory);
  await mkdir(join(directory, "affected"), { mode: 0o700 });
  const written = [join(directory, "report.json"), join(directory, "report.md"), join(directory, "table-counts.json")];
  await writeJson(written[0], result.report);
  await writeFile(written[1], formatCutoverPreflightMarkdown(result.report, result.tableCounts.tables), { mode: 0o600, flag: "wx" });
  await writeJson(written[2], result.tableCounts);
  for (const file of result.affected) {
    const path = join(directory, "affected", `${file.migrationId}.json`);
    await writeJson(path, file);
    written.push(path);
  }
  return written;
}

/** Write postflight.json and the new table-counts.json. */
export async function writeCutoverPostflight(
  directory: string,
  comparison: TableCountComparison,
  counts: TableCountsFile,
): Promise<string[]> {
  await prepareOutputDirectory(directory);
  const written = [join(directory, "postflight.json"), join(directory, "table-counts.json")];
  await writeJson(written[0], { kind: "cutover-postflight", formatVersion: 1, generatedAt: counts.generatedAt, ...comparison });
  await writeJson(written[1], counts);
  return written;
}
