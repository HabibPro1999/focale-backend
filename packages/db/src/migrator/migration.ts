import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type DatabaseEngine = "postgres" | "cockroach";
export type TransactionMode = "per-file" | "per-statement" | "none";
export type MigrationVariant = "shared" | "cockroach";

export interface MigrationDirectives {
  transaction: TransactionMode;
  requiresExtensions: string[];
  idempotent: boolean;
  deferrable: boolean;
  deferUnless?: string;
  verify: string[];
}

export interface MigrationDefinition {
  /** The four digit, globally unique migration number. */
  id: string;
  name: string;
  variant: MigrationVariant;
  filePath: string;
  source: string;
  checksum: string;
  directives: MigrationDirectives;
  statements: string[];
}

/** Works from either src/migrator in tests or dist/migrator in the CLI. */
export function defaultMigrationsDirectory(): string {
  return resolve(__dirname, "../../migrations");
}

const MIGRATION_FILE = /^(\d{4})_[a-z0-9][a-z0-9_-]*\.sql$/i;
const BREAKPOINT = /^\s*-->\s*statement-breakpoint\s*$/gm;
const MIGRATE_DIRECTIVE = /^\s*--\s*migrate:\s*(.*)$/i;

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The historical networking runner hashed each whole file exactly as stored.
 * Only the new `-- migrate:` header lines are removed so adding runner metadata
 * cannot invalidate those old checksums. Breakpoint lines remain checksum input.
 */
export function migrationChecksum(source: string): string {
  const withoutDirectives = source
    .split(/(?<=\n)/)
    .filter((line) => !/^\s*--\s*migrate:/i.test(line))
    .join("");
  return sha256(withoutDirectives);
}

/** Split only on Drizzle's explicit marker. SQL semicolons are never boundaries. */
export function splitMigrationStatements(source: string): string[] {
  return source
    .split(BREAKPOINT)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** Match the old networking step checksum: trimmed statement text, no final `;`. */
export function statementChecksum(statement: string): string {
  const withoutDirectives = statement
    .split(/(?<=\n)/)
    .filter((line) => !/^\s*--\s*migrate:/i.test(line))
    .join("");
  return sha256(withoutDirectives.trim().replace(/;\s*$/, ""));
}

function parseQuotedSql(value: string, file: string): string {
  if (!value.startsWith('"')) return value.trim();
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
  } catch {
    // The validation error below gives a migration-specific message.
  }
  throw new Error(`${file}: defer-unless must be a quoted JSON string containing SQL`);
}

export function parseMigrationDirectives(
  source: string,
  file: string,
): MigrationDirectives {
  let inHeader = true;
  let transaction: TransactionMode | undefined;
  const requiresExtensions: string[] = [];
  const verify: string[] = [];
  let idempotent = false;
  let deferrable = false;
  let deferUnless: string | undefined;

  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (inHeader) {
      const directive = line.match(MIGRATE_DIRECTIVE);
      if (directive) {
        const [key, ...rest] = directive[1].trim().split(/\s+/);
        const value = rest.join(" ");
        switch (key) {
          case "transaction":
            if (transaction) throw new Error(`${file}: duplicate transaction directive`);
            if (value !== "per-file" && value !== "per-statement" && value !== "none") {
              throw new Error(`${file}: transaction must be per-file, per-statement, or none`);
            }
            transaction = value;
            break;
          case "requires-extension":
            if (!/^[a-z][a-z0-9_]*$/i.test(value)) {
              throw new Error(`${file}: requires-extension expects one extension name`);
            }
            requiresExtensions.push(value);
            break;
          case "idempotent":
            if (value) throw new Error(`${file}: idempotent takes no value`);
            if (idempotent) throw new Error(`${file}: duplicate idempotent directive`);
            idempotent = true;
            break;
          case "deferrable":
            if (value) throw new Error(`${file}: deferrable takes no value`);
            if (deferrable) throw new Error(`${file}: duplicate deferrable directive`);
            deferrable = true;
            break;
          case "defer-unless":
            if (deferUnless) throw new Error(`${file}: duplicate defer-unless directive`);
            deferUnless = parseQuotedSql(value, file);
            break;
          case "verify":
            if (!value) throw new Error(`${file}: verify must contain a SQL query`);
            verify.push(value);
            break;
          default:
            throw new Error(`${file}: unknown migrate directive ${key ?? ""}`);
        }
        continue;
      }
      if (!trimmed || trimmed.startsWith("--") || trimmed.startsWith("/*")) continue;
      inHeader = false;
    } else if (MIGRATE_DIRECTIVE.test(line)) {
      throw new Error(`${file}: migrate directives must be at the top of the file`);
    }
  }

  if (!transaction) throw new Error(`${file}: missing -- migrate: transaction directive`);
  if (deferUnless && !deferrable) {
    throw new Error(`${file}: defer-unless requires a deferrable migration`);
  }
  if (deferrable && !deferUnless) {
    throw new Error(`${file}: deferrable migration must declare defer-unless`);
  }
  if (requiresExtensions.length !== new Set(requiresExtensions).size) {
    throw new Error(`${file}: duplicate requires-extension directive`);
  }

  return {
    transaction,
    requiresExtensions,
    idempotent,
    deferrable,
    ...(deferUnless ? { deferUnless } : {}),
    verify,
  };
}

function stripSqlCommentsAndStrings(sql: string): string {
  return sql
    .replace(/'(?:''|\\.|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
    .replace(/--[^\r\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

function semicolonCount(sql: string): number {
  return (stripSqlCommentsAndStrings(sql).match(/;/g) ?? []).length;
}

export function lintMigration(migration: MigrationDefinition): string[] {
  const errors: string[] = [];
  const executableSql = stripSqlCommentsAndStrings(migration.source);
  if (/\bCREATE\s+EXTENSION\b/i.test(executableSql)) {
    errors.push("migration files may not create extensions; declare requires-extension instead");
  }
  if (/\bBEGIN\b/i.test(executableSql)) {
    errors.push("migration files may not contain transaction control (BEGIN)");
  }
  if (migration.statements.length === 0) errors.push("migration has no executable statements");
  if (migration.directives.transaction !== "per-file" && !migration.directives.idempotent) {
    errors.push("per-statement and non-transactional migrations must declare idempotent for safe recovery");
  }
  if (migration.directives.transaction === "per-statement") {
    for (const [index, statement] of migration.statements.entries()) {
      if (semicolonCount(statement) > 1) {
        errors.push(`per-statement chunk ${index} contains multiple SQL statements; add breakpoints`);
      }
    }
  }
  return errors;
}

async function listSqlFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && MIGRATION_FILE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function invalidSqlFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql") && !MIGRATION_FILE.test(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readDefinition(
  directory: string,
  name: string,
  variant: MigrationVariant,
): Promise<MigrationDefinition> {
  const filePath = join(directory, name);
  const source = await readFile(filePath, "utf8");
  const id = name.slice(0, 4);
  const directives = parseMigrationDirectives(source, name);
  return {
    id,
    name,
    variant,
    filePath,
    source,
    checksum: migrationChecksum(source),
    directives,
    statements: splitMigrationStatements(source),
  };
}

export async function loadMigrations(
  migrationsDirectory: string,
  engine: DatabaseEngine,
  options: { through?: string } = {},
): Promise<MigrationDefinition[]> {
  const lintErrors = await lintMigrationDirectory(migrationsDirectory);
  if (lintErrors.length) throw new Error(`Migration files failed lint:\n${lintErrors.join("\n")}`);

  const sharedNames = await listSqlFiles(migrationsDirectory);
  const cockroachNames = await listSqlFiles(join(migrationsDirectory, "cockroach"));
  const sharedById = new Map(sharedNames.map((name) => [name.slice(0, 4), name]));
  const cockroachById = new Map(cockroachNames.map((name) => [name.slice(0, 4), name]));
  const ids = [...new Set([...sharedById.keys(), ...(engine === "cockroach" ? cockroachById.keys() : [])])]
    .filter((id) => !options.through || id <= options.through)
    .sort();

  const migrations = await Promise.all(ids.map(async (id) => {
    const cockroachName = engine === "cockroach" ? cockroachById.get(id) : undefined;
    const sharedName = sharedById.get(id);
    const name = cockroachName ?? sharedName;
    if (!name) throw new Error(`No migration file found for ${id}`);
    const directory = cockroachName ? join(migrationsDirectory, "cockroach") : migrationsDirectory;
    return readDefinition(directory, name, cockroachName ? "cockroach" : "shared");
  }));

  return migrations.sort((a, b) => a.id.localeCompare(b.id));
}

export async function lintMigrationDirectory(migrationsDirectory: string): Promise<string[]> {
  const cockroachDirectory = join(migrationsDirectory, "cockroach");
  const invalidFiles = [
    ...(await invalidSqlFiles(migrationsDirectory)).map((name) => join(migrationsDirectory, name)),
    ...(await invalidSqlFiles(cockroachDirectory)).map((name) => join(cockroachDirectory, name)),
  ];
  const files = [
    ...(await listSqlFiles(migrationsDirectory)).map((name) => ({ directory: migrationsDirectory, name, variant: "shared" as const })),
    ...(await listSqlFiles(cockroachDirectory)).map((name) => ({ directory: cockroachDirectory, name, variant: "cockroach" as const })),
  ];
  const seen = new Map<string, string>();
  const errors: string[] = invalidFiles.map((file) => `${file}: migration filenames must be NNNN_name.sql`);
  for (const file of files) {
    const id = file.name.slice(0, 4);
    const previous = seen.get(`${file.variant}:${id}`);
    if (previous) errors.push(`${file.name}: duplicate migration number also used by ${previous}`);
    else seen.set(`${file.variant}:${id}`, file.name);
    const migration = await readDefinition(file.directory, file.name, file.variant);
    errors.push(...lintMigration(migration).map((message) => `${file.name}: ${message}`));
  }
  return errors;
}
