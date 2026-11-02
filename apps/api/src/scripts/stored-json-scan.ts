import { checkStoredJson, type StoredJsonIssue } from "@app/contracts";
import { STORED_JSONB_COLUMNS, readStoredJsonbPage, type StoredJsonbColumn } from "@app/db";

/**
 * Read-only audit of the typed JSONB columns (plan 5.2): every stored
 * document that is not what its column's type says (`checkStoredJson`), i.e.
 * every row a read would log under JSONB_VALIDATION=warn and refuse under
 * `enforce`. Run it before switching to enforce; it writes nothing and prints
 * row ids, paths and issue codes only, never stored values (they hold
 * registrant answers and email variables). Fixing a row is a per-row decision.
 */

/** Rows read per READ ONLY transaction (keyset on the primary key). */
export const STORED_JSON_SCAN_BATCH = 500;
/** Findings kept per column for the listing; the counts cover every row. */
export const STORED_JSON_FINDINGS_PER_COLUMN = 200;

export interface StoredJsonFinding {
  column: string;
  id: string;
  issues: StoredJsonIssue[];
}

export interface StoredJsonColumnSummary {
  column: string;
  scanned: number;
  invalid: number;
  /** Rows per issue code (a row counts once per code it has). */
  byCode: Record<string, number>;
  /** The first findings, in id order (at most STORED_JSON_FINDINGS_PER_COLUMN). */
  findings: StoredJsonFinding[];
}

export interface StoredJsonReport {
  columns: StoredJsonColumnSummary[];
}

async function scanColumn(
  entry: StoredJsonbColumn,
  batchSize: number,
  findingsPerColumn: number,
): Promise<StoredJsonColumnSummary> {
  const summary: StoredJsonColumnSummary = {
    column: entry.name,
    scanned: 0,
    invalid: 0,
    byCode: {},
    findings: [],
  };
  let afterId: string | undefined;
  for (;;) {
    const rows = await readStoredJsonbPage(entry, afterId, batchSize);
    for (const row of rows) {
      summary.scanned++;
      const issues = checkStoredJson(entry.schema, row.value);
      if (issues.length === 0) continue;
      summary.invalid++;
      for (const code of new Set(issues.map((issue) => issue.code))) {
        summary.byCode[code] = (summary.byCode[code] ?? 0) + 1;
      }
      if (summary.findings.length < findingsPerColumn) {
        summary.findings.push({ column: entry.name, id: row.id, issues });
      }
    }
    if (rows.length < batchSize) return summary;
    afterId = rows[rows.length - 1]!.id;
  }
}

/** Scan every typed JSONB column, batch by batch, each batch in a READ ONLY transaction. */
export async function loadStoredJsonReport(
  options: { batchSize?: number; findingsPerColumn?: number } = {},
): Promise<StoredJsonReport> {
  const batchSize = options.batchSize ?? STORED_JSON_SCAN_BATCH;
  const findingsPerColumn = options.findingsPerColumn ?? STORED_JSON_FINDINGS_PER_COLUMN;
  const columns: StoredJsonColumnSummary[] = [];
  for (const entry of STORED_JSONB_COLUMNS) {
    columns.push(await scanColumn(entry, batchSize, findingsPerColumn));
  }
  return { columns };
}

export function formatStoredJsonReport(report: StoredJsonReport): string[] {
  const lines: string[] = [];
  for (const column of report.columns) {
    for (const finding of column.findings) {
      const issues = finding.issues.map((issue) => `${issue.path} (${issue.code})`).join(", ");
      lines.push(`[${finding.column}] id ${finding.id}: ${issues}`);
    }
    if (column.invalid > column.findings.length) {
      lines.push(
        `[${column.column}] ... ${column.invalid - column.findings.length} more invalid row(s) not listed`,
      );
    }
  }
  for (const column of report.columns) {
    const codes = Object.entries(column.byCode)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, rows]) => `${code} ${rows}`)
      .join(", ");
    lines.push(
      `${column.column}: scanned ${column.scanned} row(s), ${column.invalid} invalid${codes ? ` (${codes})` : ""}`,
    );
  }
  const invalid = report.columns.reduce((total, column) => total + column.invalid, 0);
  lines.push(
    invalid === 0
      ? "Every typed JSON document matches its schema: JSONB_VALIDATION=enforce would refuse nothing. Nothing was changed."
      : `${invalid} stored document(s) do not match their schema: JSONB_VALIDATION=enforce would refuse them. Nothing was changed.`,
  );
  return lines;
}
