/* eslint no-console: "off" */
import { parseArgs } from "node:util";
import { getDb, closeDb, configureDb, networkingKeyRetirementBlockers, networkingKeyUsage, resealNetworkingSecrets } from "@app/db";
import { networkingKeyring } from "@app/shared";
import { loadConfig } from "../core/config";

// Networking keyring runbook (plan 4.5; steps in NETWORKING.md). Read-only
// unless `reseal --apply`:
//   status                     keys, write format and what still uses each key
//   reseal [--apply]           re-seal authenticator secrets with the current key (dry run by default)
//   retire --kid=<kid> [--keep-recovery]
//                              exit 1 while anything still needs <kid>; with --keep-recovery
//                              only its recovery codes may remain (keep it as <kid>:<key>:recovery)

function usageError(): never {
  throw new Error("Usage: networking-keyring <status | reseal [--apply] | retire --kid=<kid> [--keep-recovery]>");
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { apply: { type: "boolean" }, kid: { type: "string" }, "keep-recovery": { type: "boolean" } },
  });
  const [command = "status", ...extra] = positionals;
  if (extra.length) usageError();
  const config = loadConfig();
  configureDb({ applicationName: "focale-networking-keyring", databaseUrl: config.DATABASE_URL, settings: config.database });
  const { tokenSecret, keys, keyringWriteV1 } = config.integrations.networking;
  const keyring = networkingKeyring({ legacySecret: tokenSecret, keys, writeV1: keyringWriteV1 });
  if (!keyring.configured) throw new Error("No networking keys are configured (NETWORKING_TOKEN_SECRET / NETWORKING_KEYS)");
  try {
    const printUsage = async () => {
      const usage = await networkingKeyUsage();
      console.log(`keys: ${keyring.kids().map(({ kid, recoveryOnly }) => `${kid}${recoveryOnly ? " (recovery only)" : ""}`).join(", ")}`);
      console.log(`writes: ${keyring.writesV1 ? `v1 with ${keyring.currentKid}` : "legacy format (NETWORKING_KEYRING_WRITE_V1=false)"}`);
      for (const row of usage) console.log(`${row.use.padEnd(9)} ${row.kid.padEnd(17)} ${row.count}`);
      return usage;
    };
    if (command === "status") {
      if (values.apply || values.kid || values["keep-recovery"]) usageError();
      await printUsage();
      return 0;
    }
    if (command === "reseal") {
      if (values.kid || values["keep-recovery"]) usageError();
      if (!keyring.writesV1) console.log("Writes use the legacy format; set NETWORKING_KEYRING_WRITE_V1=true before resealing.");
      const result = await resealNetworkingSecrets(keyring, getDb(), { apply: !!values.apply });
      console.log(`${values.apply ? "Resealed" : "Would reseal"} ${result.resealed} of ${result.checked} authenticator secrets; ${result.unreadable} unreadable (key missing).`);
      await printUsage();
      if (!values.apply) console.log("Dry run: pass --apply to write.");
      return result.unreadable ? 1 : 0;
    }
    if (command === "retire") {
      if (!values.kid || values.apply) usageError();
      const usage = await printUsage();
      const blockers = networkingKeyRetirementBlockers(usage, values.kid, {
        currentKid: keyring.currentKid,
        keepRecovery: !!values["keep-recovery"],
      });
      if (blockers.length) {
        console.error(`Refusing to retire ${values.kid}:`);
        for (const blocker of blockers) console.error(`  - ${blocker}`);
        return 1;
      }
      console.log(values["keep-recovery"]
        ? `${values.kid} may be kept for recovery only: list it as ${values.kid}:<key>:recovery in NETWORKING_KEYS.`
        : `${values.kid} may be removed from the keyring.`);
      return 0;
    }
    return usageError();
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
