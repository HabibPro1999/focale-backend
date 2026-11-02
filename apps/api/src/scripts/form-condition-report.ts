import { closeDb, configureDb } from "@app/db";
import {
  formatFormConditionReport,
  loadFormConditionReport,
} from "./form-condition-scan";

// Read-only report of form-field conditions the public form app evaluates
// differently from their configuration (uppercase conditionLogic, non-string
// values, unknown operators or fields). It runs one READ ONLY transaction and
// changes nothing; fixing a form is a per-form decision.
//
// Run from apps/api after a build: `node dist/scripts/form-condition-report.js`
// (or from source: `node --conditions=@app/source -r @swc-node/register src/scripts/form-condition-report.ts`).
async function main(): Promise<void> {
  const unknownArgs = process.argv.slice(2);
  if (unknownArgs.length > 0) {
    throw new Error(`Unknown argument(s): ${unknownArgs.join(", ")}`);
  }
  configureDb({ applicationName: "focale-form-condition-report" });
  try {
    const report = await loadFormConditionReport();
    for (const line of formatFormConditionReport(report)) {
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
