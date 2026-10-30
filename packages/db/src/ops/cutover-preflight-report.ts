import type {
  CutoverPreflightReport,
  TableCountComparison,
  TableCountsFile,
} from "./cutover-preflight";

export interface PreflightFinding {
  /** blocker: apply would fail, or the preflight could not prove something. review: needs a decision or sign-off. */
  level: "blocker" | "review";
  topic: string;
  message: string;
}

export const PERSONAL_DATA_NOTICE =
  "The affected/ files contain personal data (registration and abstract identifiers, sponsorship codes, " +
  "amounts and timestamps). Store this directory with restricted access, share it only with the people " +
  "who sign off the cutover, and delete it once the cutover is accepted.";

export const POSTFLIGHT_TIMING_NOTICE =
  "Run postflight right after `apply` and `verify --schema`, before the Nest worker starts: its retention " +
  "jobs delete old outbox rows, and normal application deletes also lower counts.";

export const POSTFLIGHT_COMMAND = "node packages/db/dist/ops/cutover-preflight-cli.js postflight --baseline <dir>/table-counts.json";

/**
 * Whether `apply` will execute a migration: pending in the ledger, or (no
 * ledger yet) anything adopt does not record as applied. A deferred one runs
 * only with --apply-deferred.
 */
export function migrationWillRun(report: Pick<CutoverPreflightReport, "migrations">, id: string): boolean {
  const migration = report.migrations.find((candidate) => candidate.id === id);
  if (!migration) return false;
  if (migration.ledger === "no-ledger") return migration.adopt !== "applied" && migration.adopt !== "baseline";
  return migration.ledger === "pending";
}

function settingTrue(value: unknown): boolean {
  return value === true || value === "true" || value === "on";
}

export function preflightFindings(report: CutoverPreflightReport): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  const blocker = (topic: string, message: string) => findings.push({ level: "blocker", topic, message });
  const review = (topic: string, message: string) => findings.push({ level: "review", topic, message });

  for (const error of report.errors) blocker(error.section, `could not be read: ${error.message}`);
  for (const [table, message] of Object.entries(report.tableCounts.errors)) blocker("table counts", `${table} could not be counted: ${message}`);
  if (report.ledger.unknown.length) {
    blocker("ledger", `records ${report.ledger.unknown.join(", ")}, unknown to this build; apply refuses to run`);
  }
  if (report.adopt.ran && report.adopt.aborted) {
    blocker("adopt", `the dry run aborts, so adopt --apply would write nothing: ${(report.adopt.errors ?? []).join("; ")}`);
  }

  for (const check of report.dataChecks) {
    const topic = `${check.migrationId} ${check.file}`;
    if (check.status === "fails") blocker(topic, check.summary);
    else if (check.status === "error") blocker(topic, `the check could not run: ${check.error ?? "unknown error"}`);
    else if (check.review) review(topic, check.summary);
  }
  for (const migration of report.migrations) {
    if (migration.check || !migrationWillRun(report, migration.id)) continue;
    const populated = migration.modifies.filter((entry) => (entry.rows ?? 0) > 0);
    if (populated.length) {
      review(
        `${migration.id} ${migration.name}`,
        `changes existing rows of ${populated.map((entry) => `${entry.table} (${entry.rows} rows)`).join(", ")} and has no dedicated export; read its SQL before apply`,
      );
    }
  }

  if (report.database.engine === "cockroach") {
    const vector = report.database.settings["feature.vector_index.enabled"];
    if (migrationWillRun(report, "0017")) {
      // preconditions.ts reads this setting for the pending 0017 without a
      // fallback: an unreadable setting stops apply there.
      if (vector?.error) blocker("feature.vector_index.enabled", `unreadable (${vector.error}); apply reads it for 0017 and stops when it cannot`);
      else if (!settingTrue(vector?.value)) review("feature.vector_index.enabled", "off: apply records 0017 as deferred (no ANN index until it is enabled)");
    }
    const readCommitted = report.database.settings["sql.txn.read_committed_isolation.enabled"];
    if (readCommitted?.error) review("sql.txn.read_committed_isolation.enabled", `unreadable (${readCommitted.error})`);
    else if (!settingTrue(readCommitted?.value)) {
      review("sql.txn.read_committed_isolation.enabled", "off: READ COMMITTED transactions run as SERIALIZABLE (docs/adr/0001-concurrency-control.md assumes on)");
    }
  }

  for (const queue of report.queues ?? []) {
    if (queue.inFlight > 0) {
      review(`queue ${queue.table}`, `${queue.inFlight} row(s) claimed by a worker right now; stop the legacy workers and drain before the Nest worker starts`);
    }
  }
  if (report.sponsoredVerifying && report.sponsoredVerifying.count > 0) {
    review("sponsored VERIFYING", `${report.sponsoredVerifying.count} registration(s): reconcile paid_count by hand (readiness report section 5 item 12)`);
  }
  const origins = new Set<string>();
  let unparsed = 0;
  for (const entry of [...(report.linkOrigins.registrations ?? []), ...(report.linkOrigins.abstracts ?? [])]) {
    if (entry.origin) origins.add(entry.origin);
    else unparsed += entry.count;
  }
  if (origins.size) review("PUBLIC_LINK_ALLOWED_ORIGINS", `must list every form origin still in use: ${[...origins].join(", ")}`);
  if (unparsed) review("PUBLIC_LINK_ALLOWED_ORIGINS", `${unparsed} stored link_base_url value(s) have no http(s) origin`);
  return findings;
}

function cell(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function table(headers: string[], rows: unknown[][]): string[] {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ];
}

export function formatCutoverPreflightMarkdown(report: CutoverPreflightReport, counts: TableCountsFile["tables"]): string {
  const lines: string[] = [];
  const blockers = report.findings.filter((finding) => finding.level === "blocker");
  const reviews = report.findings.filter((finding) => finding.level === "review");
  const probe = "table" in report.session.writeProbe
    ? `write probe \`DELETE FROM ${report.session.writeProbe.table} WHERE false\` refused with SQLSTATE ${report.session.writeProbe.sqlstate}`
    : `write probe skipped (${report.session.writeProbe.skipped})`;

  lines.push("# Cutover preflight", "");
  lines.push(`> **Personal data.** ${report.notice}`, "");
  lines.push(`Generated ${report.generatedAt} on ${report.database.engine} database \`${report.database.name}\`.`);
  lines.push(`Version: ${report.database.version}`);
  lines.push(
    `Read-only: one ${report.session.isolation} READ ONLY transaction on a session whose default is read-only, ` +
      `rolled back at the end; ${probe}.`,
    "",
  );

  lines.push("## Verdict", "");
  lines.push(
    blockers.length
      ? `**${blockers.length} blocker(s), ${reviews.length} item(s) to review.** Resolve every blocker before \`adopt --apply\` and \`apply\`.`
      : `**No blocker; ${reviews.length} item(s) to review.**`,
    "",
  );
  for (const finding of [...blockers, ...reviews]) {
    lines.push(`- ${finding.level === "blocker" ? "**Blocker**" : "Review"} (${finding.topic}): ${finding.message}`);
  }
  if (report.findings.length) lines.push("");

  if (report.database.engine === "cockroach") {
    lines.push("## CockroachDB settings", "");
    lines.push(...table(["Setting", "Value"], Object.entries(report.database.settings).map(([name, setting]) =>
      [name, setting.error ? `unreadable: ${setting.error}` : String(setting.value)])), "");
  }

  lines.push("## Migration ledger", "");
  if (!report.ledger.present) lines.push("No `schema_migrations` table: the database has not been adopted yet.");
  else {
    lines.push(`\`schema_migrations\` records ${report.ledger.records.length} migration(s).`);
    const deferred = report.ledger.records.filter((record) => record.status === "deferred").map((record) => record.id);
    if (deferred.length) lines.push(`Deferred: ${deferred.join(", ")}.`);
    lines.push(`Pending: ${report.ledger.pending.join(", ") || "none"}.`);
    if (report.ledger.unknown.length) lines.push(`Unknown to this build: ${report.ledger.unknown.join(", ")}.`);
  }
  lines.push("");

  lines.push("## Adopt dry run", "");
  if (report.adopt.ran) lines.push("The migrator's `adopt` planner, dry run (nothing written):", "", "```text", ...(report.adopt.lines ?? []), "```");
  else lines.push(`Not run: ${report.adopt.skipped ?? "unknown reason"}.`);
  lines.push("");

  lines.push("## Data changes per migration", "");
  lines.push(...table(
    ["Migration", "Ledger / adopt", "Status", "Rows", "Export", "What happens"],
    report.dataChecks.map((check) => [
      check.file,
      check.adopt ? `${check.ledger} / ${check.adopt}` : check.ledger,
      check.status,
      check.affectedRows,
      check.export ?? "",
      check.error ? `${check.summary}: ${check.error}` : check.summary,
    ]),
  ), "");
  for (const check of report.dataChecks) lines.push(`- ${check.migrationId}: ${check.effect}. Predicate: ${check.source.join(", ")}.`);
  const unchecked = report.migrations.filter((migration) => migration.modifies.length && !migration.check);
  if (unchecked.length) {
    lines.push("", "Other migrations whose SQL changes existing rows (no dedicated export; a review item when apply will run one on a table with rows):", "");
    for (const migration of unchecked) {
      const tables = migration.modifies.map((entry) => `${entry.table} ${entry.rows === null ? "(not created yet)" : `(${entry.rows} rows)`}`).join(", ");
      lines.push(`- ${migration.id} ${migration.name}: ${migrationWillRun(report, migration.id) ? "apply will run it" : "apply will not run it"}; ${tables}.`);
    }
  }
  lines.push("");

  lines.push("## Foreign-key names", "");
  if (!report.foreignKeys) lines.push("Could not be read (see Verdict).");
  else {
    const keys = report.foreignKeys;
    lines.push(`${keys.total} foreign keys: ${keys.prismaNamed} Prisma-named (\`_fkey\`), ${keys.drizzleNamed} Drizzle-named (\`_fk\`), ${keys.otherNamed} other.`, "");
    lines.push(...table(
      ["Migration", "Declared", "By declared name", "By Prisma name", "Missing"],
      keys.byMigration.map((entry) => [entry.migrationId, entry.declared, entry.byDeclaredName, entry.byPrismaName, entry.missing.length]),
    ));
    lines.push("", "Missing keys of a migration that is still pending are expected; its tables do not exist yet.");
  }
  lines.push("");

  lines.push("## Queues", "");
  if (!report.queues) lines.push("Could not be read (see Verdict).");
  else {
    lines.push(...table(["Table", "Counts", "In flight"], report.queues.map((queue) => [
      queue.table,
      Object.entries(queue.counts).map(([status, count]) => `${status} ${count}`).join(", "),
      queue.inFlight,
    ])));
  }
  lines.push("");

  lines.push("## Email status counts", "");
  if (!report.emailStatusCounts) lines.push("Could not be read (see Verdict).");
  else lines.push(Object.entries(report.emailStatusCounts).map(([status, count]) => `${status} ${count}`).join(", ") || "No email_logs rows.");
  lines.push("");

  lines.push("## Public link origins (PUBLIC_LINK_ALLOWED_ORIGINS)", "");
  for (const [name, origins] of Object.entries(report.linkOrigins)) {
    lines.push(`${name}:`, "");
    if (!origins) lines.push("Could not be read (see Verdict).");
    else if (!origins.length) lines.push("No stored link_base_url.");
    else lines.push(...table(["Origin", "Rows", "Last seen"], origins.map((origin) => [origin.origin ?? "(no http(s) origin)", origin.count, origin.lastSeen])));
    lines.push("");
  }

  lines.push("## Sponsored VERIFYING registrations", "");
  lines.push(report.sponsoredVerifying ? `${report.sponsoredVerifying.count} (ids in report.json).` : "Could not be read (see Verdict).", "");

  lines.push("## Table row counts", "");
  lines.push(`${report.tableCounts.tables} tables, ${report.tableCounts.rows} rows in total (the postflight baseline is \`${report.tableCounts.file}\`).`, "");
  lines.push(...table(["Table", "Rows"], Object.entries(counts).map(([name, rows]) => [name, rows])), "");

  lines.push("## After the cutover", "");
  lines.push("```sh", POSTFLIGHT_COMMAND, "```", "");
  lines.push(`${POSTFLIGHT_TIMING_NOTICE} It exits non-zero when a table lost rows or vanished; abstract_code_sequences vanishing is expected (0033).`, "");
  return `${lines.join("\n")}\n`;
}

export function formatPostflight(comparison: TableCountComparison, current: TableCountsFile): string[] {
  const lines: string[] = [`Postflight (${current.engine} database "${current.database}"): ${comparison.ok ? "no table lost rows" : "FAILED"}`];
  for (const warning of comparison.warnings) lines.push(`warning: ${warning}`);
  for (const entry of comparison.vanished) lines.push(`error: ${entry.table} vanished (had ${entry.before} rows)`);
  for (const entry of comparison.lost) lines.push(`error: ${entry.table} lost ${entry.before - entry.after} row(s): ${entry.before} -> ${entry.after}`);
  for (const entry of comparison.uncounted) lines.push(`error: ${entry.table} could not be compared: ${entry.reason}`);
  for (const entry of comparison.exempt) lines.push(`expected: ${entry.table} dropped (had ${entry.before} rows): ${entry.reason}`);
  for (const entry of comparison.added) lines.push(`new table: ${entry.table} (${entry.after} rows)`);
  for (const entry of comparison.grown) lines.push(`grew: ${entry.table} ${entry.before} -> ${entry.after}`);
  lines.push(`unchanged: ${comparison.unchanged} table(s)`);
  return lines;
}

// ---------------------------------------------------------------------------
// Command line (cutover-preflight-cli.ts).

export const CUTOVER_CLI_HELP = `Usage:
  cutover-preflight preflight --out <dir>
  cutover-preflight postflight --baseline <dir>/table-counts.json [--out <dir2>]

Both commands read DATABASE_URL and run every query in one READ ONLY
transaction on a read-only session; nothing is written to the database.

preflight writes, into a new or empty <dir>:
  report.json, report.md   engine and settings, ledger, the migrator's adopt
                           dry run, foreign-key names, what each data-changing
                           migration (0004, 0006, 0010, 0011, 0030, 0033) will
                           do, queues, email statuses, public link origins,
                           sponsored VERIFYING registrations, and the verdict
  table-counts.json        the row count of every table (postflight baseline)
  affected/<id>.json       every row a migration will modify or that makes it
                           fail, with its current values
It exits 1 when the report lists a blocker.

${PERSONAL_DATA_NOTICE}

postflight recounts every table and exits 1 when a table lost rows or
vanished, except abstract_code_sequences (dropped by 0033). With --out it
writes postflight.json and the new table-counts.json into a new or empty <dir2>.
${POSTFLIGHT_TIMING_NOTICE}
`;

export interface CutoverCliArguments {
  command: string;
  options: Map<string, string>;
  help: boolean;
}

/** Accepts `--name value` and `--name=value` for the options each command allows. */
export function parseCutoverCliArguments(argv: string[]): CutoverCliArguments {
  const [command = "", ...rest] = argv;
  const options = new Map<string, string>();
  let help = command === "--help" || command === "-h" || command === "help";
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    const match = /^(--[a-z][a-z-]*)(?:=(.*))?$/.exec(argument);
    if (!match) throw new Error(`Unexpected argument: ${argument}`);
    const value = match[2] ?? rest[index + 1];
    if (match[2] === undefined) index += 1;
    if (!value || value.startsWith("--")) throw new Error(`${match[1]} needs a value`);
    if (options.has(match[1])) throw new Error(`${match[1]} is given twice`);
    options.set(match[1], value);
  }
  return { command, options, help };
}
