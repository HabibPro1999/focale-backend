/* eslint no-console: "off" */
import { closeDb, configureDb } from "@app/db";
import { configureIntegrations, getStorageProvider } from "@app/integrations";
import { loadConfig } from "../core/config";
import {
  BACKFILL_CERTIFICATE_RENDERS_USAGE,
  parseBackfillCertificateRenderArgs,
  runBackfillCertificateRenders,
} from "./backfill-certificate-renders-ops";

// Backfill certificate render images (plan 3.8); see the ops module. Dry run by
// default, --apply to store them.

async function main(): Promise<number> {
  const options = parseBackfillCertificateRenderArgs(process.argv.slice(2));
  if (options === "help") {
    console.log(BACKFILL_CERTIFICATE_RENDERS_USAGE);
    return 0;
  }
  const config = loadConfig();
  configureDb({
    applicationName: "focale-backfill-certificate-renders",
    databaseUrl: config.DATABASE_URL,
    settings: config.database,
  });
  configureIntegrations(config.integrations);
  try {
    const counts = await runBackfillCertificateRenders(options, getStorageProvider(), console.log);
    return counts.failed > 0 ? 2 : 0;
  } finally {
    await closeDb();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(BACKFILL_CERTIFICATE_RENDERS_USAGE);
    process.exitCode = 1;
  },
);
