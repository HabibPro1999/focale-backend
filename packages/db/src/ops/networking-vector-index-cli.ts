#!/usr/bin/env node
/* eslint no-console: "off" */
// Runbook for the networking ANN index (plan 4.10). Read-only unless `build --yes`.
//   node packages/db/dist/ops/networking-vector-index-cli.js status
//   node packages/db/dist/ops/networking-vector-index-cli.js build --yes
import { Client } from "pg";
import { parseArguments, requireKnownOptions, requireNoPositionals } from "../migrator/cli-arguments";
import { defaultMigrationsDirectory } from "../migrator/migration";
import { redactCredentials } from "../migrator/security";
import {
  buildNetworkingVectorIndex,
  formatNetworkingVectorIndexReport,
  networkingVectorIndexBuildBlocker,
  networkingVectorIndexReport,
} from "./networking-vector-index";

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

async function withClient<T>(run: (client: Client, connectionString: string) => Promise<T>): Promise<T> {
  const connectionString = databaseConnectionString();
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await run(client, connectionString);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const command = args.command || "status";
  requireNoPositionals(args, command);
  if (command === "status") {
    requireKnownOptions(args, [], []);
    await withClient(async (client) => {
      const report = await networkingVectorIndexReport(client);
      for (const line of formatNetworkingVectorIndexReport(report)) console.log(line);
      const blocker = networkingVectorIndexBuildBlocker(report);
      console.log(blocker ? `build: not possible now — ${blocker}` : "build: ready (maintenance window: build --yes)");
    });
    return;
  }
  if (command === "build") {
    requireKnownOptions(args, ["--yes"], []);
    if (!args.flags.has("--yes"))
      throw new Error("Building blocks writes to networking_embeddings until the backfill finishes. Stop the worker, then pass --yes");
    await withClient(async (client, connectionString) => {
      const result = await buildNetworkingVectorIndex(client, {
        connectionString,
        migrationsDirectory: defaultMigrationsDirectory(),
        appliedBy: process.env.MIGRATIONS_APPLIED_BY,
        onStart: () => console.log("Building the networking vector index (migration 0017); embedding writes block until it finishes…"),
      });
      console.log(`Built in ${Math.round(result.durationMs / 1000)} s.`);
      for (const line of formatNetworkingVectorIndexReport(result.after)) console.log(line);
      console.log("Restart the worker. API processes pick the index up within a minute.");
    });
    return;
  }
  throw new Error("Usage: networking-vector-index <status|build --yes>");
}

main().catch((error: unknown) => {
  console.error(redactCredentials(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
