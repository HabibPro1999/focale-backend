/* eslint no-console: "off" */
import { closeDb, configureDb } from "@app/db";
import { configureIntegrations, getStorageProvider } from "@app/integrations";
import { loadConfig } from "../core/config";
import {
  parseNetworkingRetentionArgs,
  runEraseWithdrawn,
  runOrphanPhotos,
  runPurgeLeftovers,
} from "./networking-retention-ops";

// Networking retention runbook (plan 4.4; operator steps in NETWORKING.md):
//   purge-leftovers   events past retention still holding networking data, and
//                     networking email logs of deleted events
//   erase-withdrawn   withdrawn profiles past NETWORKING_WITHDRAWAL_ERASE_DAYS
//   orphan-photos     profile photos in storage that no profile references
// Dry run by default; --apply only with --backup-verified=<reference>.

async function main(): Promise<number> {
  const options = parseNetworkingRetentionArgs(process.argv.slice(2));
  const config = loadConfig();
  configureDb({ applicationName: "focale-networking-retention", databaseUrl: config.DATABASE_URL, settings: config.database });
  try {
    if (options.command === "purge-leftovers") await runPurgeLeftovers(options, console.log);
    else if (options.command === "erase-withdrawn")
      await runEraseWithdrawn(options, config.NETWORKING_WITHDRAWAL_ERASE_DAYS, console.log);
    else {
      configureIntegrations(config.integrations);
      await runOrphanPhotos(options, getStorageProvider(), console.log);
    }
    return 0;
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
    process.exitCode = 1;
  },
);
