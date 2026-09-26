import { closeDb, configureDb } from "@app/db";
import { formatStoredJsonReport, loadStoredJsonReport } from "./stored-json-scan";

// Read-only audit of the typed JSONB columns (plan 5.2): lists every stored
// document a read would log under JSONB_VALIDATION=warn and refuse under
// `enforce` (row ids, paths and issue codes; never values). It only reads,
// batch by batch in READ ONLY transactions, and changes nothing; run it and
// fix (or accept) what it lists before setting JSONB_VALIDATION=enforce.
//
// Run from apps/api after a build: `node dist/scripts/stored-json-report.js`
// (or from source: `node --conditions=@app/source -r @swc-node/register src/scripts/stored-json-report.ts`).
async function main(): Promise<void> {
  const unknownArgs = process.argv.slice(2);
  if (unknownArgs.length > 0) {
    throw new Error(`Unknown argument(s): ${unknownArgs.join(", ")}`);
  }
  configureDb({ applicationName: "focale-stored-json-report" });
  try {
    const report = await loadStoredJsonReport();
    for (const line of formatStoredJsonReport(report)) {
      process.stdout.write(`${line}\n`);
    }
  } finally {
    await closeDb();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
