import { jsonb } from "drizzle-orm/pg-core";
import {
  checkStoredJson,
  resolveJsonbValidationMode,
  type JsonbValidationMode,
  type StoredJsonIssue,
  type StoredJsonOf,
  type StoredJsonSchema,
} from "@app/contracts";
import { createLogger } from "@app/shared";

// Typed JSONB columns (plan 5.2). `jsonbOf(schema)` types a column with the
// document its schema describes (`@app/contracts` Stored*Schema); reads that
// hand such a column to callers pass it through `parseJsonb` so a document
// that is not what the type says (legacy rows, hand edits) is caught at the
// boundary instead of deep inside a service. JSONB_VALIDATION picks what
// happens then: `warn` (default) logs and returns the value exactly as stored,
// so behaviour is unchanged; `enforce` throws StoredJsonError.

const log = createLogger({ name: "db:jsonb" });

/** A `jsonb` column typed with the document `schema` describes. */
export function jsonbOf<S extends StoredJsonSchema>(_schema: S) {
  return jsonb().$type<StoredJsonOf<S>>();
}

/** Set by configureDb from the app config; tools and tests fall back to the environment. */
let configuredMode: JsonbValidationMode | undefined;
let envMode: JsonbValidationMode | undefined;

/** Set this process's JSONB_VALIDATION mode (undefined: read the environment again). */
export function configureJsonbValidation(mode: JsonbValidationMode | undefined): void {
  configuredMode = mode;
  envMode = undefined;
}

export function getJsonbValidationMode(): JsonbValidationMode {
  if (configuredMode) return configuredMode;
  envMode ??= resolveJsonbValidationMode(process.env);
  return envMode;
}

/** Which stored document: `table.column`, plus the row id when the read has it. */
export interface StoredJsonLocation {
  column: string;
  id?: string | null;
}

function describe(location: StoredJsonLocation, issues: readonly StoredJsonIssue[]): string {
  const where = location.id ? `${location.column} (id ${location.id})` : location.column;
  const shown = issues.slice(0, 10).map((issue) => `${issue.path} (${issue.code})`);
  const more = issues.length > shown.length ? `, +${issues.length - shown.length} more` : "";
  return `Stored JSON ${where} does not match its schema: ${shown.join(", ")}${more}`;
}

/** Thrown by parseJsonb under JSONB_VALIDATION=enforce. Paths and codes only, never values. */
export class StoredJsonError extends Error {
  readonly column: string;
  readonly rowId: string | null;
  readonly issues: readonly StoredJsonIssue[];

  constructor(location: StoredJsonLocation, issues: readonly StoredJsonIssue[]) {
    super(describe(location, issues));
    this.name = "StoredJsonError";
    this.column = location.column;
    this.rowId = location.id ?? null;
    this.issues = issues;
  }
}

// One warning per distinct (column, row, issues) per process: a bad form
// schema is read on every public page view, and repeating the same warning
// would drown the logs. Bounded so a scan of many bad rows cannot grow it
// without limit (past the bound, warnings simply repeat).
const WARNED_LIMIT = 1_000;
const warned = new Set<string>();

function warnOnce(location: StoredJsonLocation, issues: readonly StoredJsonIssue[]): void {
  const signature = `${location.column}|${location.id ?? ""}|${issues
    .map((issue) => `${issue.path}:${issue.code}`)
    .join(",")}`;
  if (warned.has(signature)) return;
  if (warned.size < WARNED_LIMIT) warned.add(signature);
  log.warn(
    {
      column: location.column,
      rowId: location.id ?? undefined,
      issueCount: issues.length,
      issues: issues.slice(0, 20),
      jsonbValidation: "warn",
    },
    "Stored JSON does not match its schema; using it as stored (JSONB_VALIDATION=warn)",
  );
}

/** Forget which warnings were already logged (tests). */
export function resetStoredJsonWarnings(): void {
  warned.clear();
}

/**
 * Check a typed JSON column value read from the database against its stored
 * document schema. Returns the value itself (same reference, never a parsed
 * copy, so responses keep their bytes) when it is valid, or when it is not
 * and JSONB_VALIDATION=warn (after logging where, never what); throws
 * StoredJsonError under `enforce`.
 */
export function parseJsonb<S extends StoredJsonSchema>(
  schema: S,
  value: unknown,
  location: StoredJsonLocation,
): StoredJsonOf<S> {
  const issues = checkStoredJson(schema, value);
  if (issues.length > 0) {
    if (getJsonbValidationMode() === "enforce") throw new StoredJsonError(location, issues);
    warnOnce(location, issues);
  }
  return value as StoredJsonOf<S>;
}
