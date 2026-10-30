#!/usr/bin/env node
/* eslint no-console: "off" */
// Read-only cutover checks against the production database (see CUTOVER_CLI_HELP).
//   node packages/db/dist/ops/cutover-preflight-cli.js preflight --out <dir>
//   node packages/db/dist/ops/cutover-preflight-cli.js postflight --baseline <dir>/table-counts.json [--out <dir2>]
import { readFile } from "node:fs/promises";
import { defaultMigrationsDirectory } from "../migrator/migration";
import { redactCredentials } from "../migrator/security";
import {
  collectTableCounts,
  compareTableCounts,
  parseTableCountsFile,
  runCutoverPreflight,
  writeCutoverPostflight,
  writeCutoverPreflight,
} from "./cutover-preflight";
import {
  CUTOVER_CLI_HELP,
  PERSONAL_DATA_NOTICE,
  formatPostflight,
  parseCutoverCliArguments,
  type CutoverCliArguments,
} from "./cutover-preflight-report";

function requireOptions(args: CutoverCliArguments, required: string[], optional: string[]): void {
  const known = new Set([...required, ...optional]);
  for (const name of args.options.keys()) if (!known.has(name)) throw new Error(`Unknown option for ${args.command}: ${name}`);
  for (const name of required) if (!args.options.has(name)) throw new Error(`${args.command} needs ${name}`);
}

function databaseConnectionString(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DATABASE_URL is not a valid PostgreSQL connection URL");
  }
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol)) throw new Error("DATABASE_URL must use postgres:// or postgresql://");
  return parsed.toString();
}

async function preflight(args: CutoverCliArguments): Promise<void> {
  requireOptions(args, ["--out"], []);
  const out = args.options.get("--out")!;
  const result = await runCutoverPreflight({
    connectionString: databaseConnectionString(),
    migrationsDirectory: defaultMigrationsDirectory(),
  });
  const written = await writeCutoverPreflight(out, result);
  const blockers = result.report.findings.filter((finding) => finding.level === "blocker");
  const reviews = result.report.findings.length - blockers.length;
  console.log(`Cutover preflight (${result.report.database.engine}, read-only): ${blockers.length} blocker(s), ${reviews} item(s) to review.`);
  for (const finding of blockers) console.error(`blocker: ${finding.topic}: ${finding.message}`);
  for (const path of written) console.log(`wrote ${path}`);
  console.log(`Read ${written[1]}. ${PERSONAL_DATA_NOTICE}`);
  if (blockers.length) process.exitCode = 1;
}

async function postflight(args: CutoverCliArguments): Promise<void> {
  requireOptions(args, ["--baseline"], ["--out"]);
  const baseline = parseTableCountsFile(await readFile(args.options.get("--baseline")!, "utf8"));
  const current = await collectTableCounts(databaseConnectionString());
  const comparison = compareTableCounts(baseline, current);
  for (const line of formatPostflight(comparison, current)) {
    if (line.startsWith("error:")) console.error(line);
    else console.log(line);
  }
  const out = args.options.get("--out");
  if (out) for (const path of await writeCutoverPostflight(out, comparison, current)) console.log(`wrote ${path}`);
  if (!comparison.ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = parseCutoverCliArguments(process.argv.slice(2));
  if (args.help || !args.command) {
    console.log(CUTOVER_CLI_HELP);
    if (!args.help) process.exitCode = 1;
    return;
  }
  if (args.command === "preflight") return preflight(args);
  if (args.command === "postflight") return postflight(args);
  throw new Error(`Unknown command ${args.command}\n\n${CUTOVER_CLI_HELP}`);
}

main().catch((error: unknown) => {
  console.error(redactCredentials(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
