#!/usr/bin/env node
/* global process, URL */
import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const args = new Set(process.argv.slice(2));
const throughArg = [...args].find((arg) => arg.startsWith("--through="));
const deferredArg = [...args].find((arg) => arg.startsWith("--apply-deferred="));
const apply = args.has("--apply");
const bootstrapTest = args.has("--bootstrap-test");

for (const arg of args) {
  if (arg === "--apply" || arg === "--bootstrap-test") continue;
  if (/^--through=\d{4}$/.test(arg) || /^--apply-deferred=\d{4}$/.test(arg)) continue;
  throw new Error("Unknown migration option");
}
if (throughArg && !/^--through=\d{4}$/.test(throughArg)) throw new Error("Use --through=NNNN");
if (deferredArg && !/^--apply-deferred=\d{4}$/.test(deferredArg)) {
  throw new Error("Use --apply-deferred=NNNN");
}
if (bootstrapTest && !apply) throw new Error("--bootstrap-test requires --apply");

if (bootstrapTest) {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required for --bootstrap-test");
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("DATABASE_URL is invalid for --bootstrap-test");
  }
  const databaseName = decodeURIComponent(url.pathname);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/(focale_)?networking_test_[a-z0-9_]+$/.test(databaseName)
  ) {
    throw new Error("--bootstrap-test requires a local dedicated networking_test database");
  }
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(scriptDirectory, "../dist/migrator/cli.js");
try {
  await access(cliPath);
} catch {
  throw new Error("The unified migrator is not built; run `pnpm --filter @app/db build` first");
}

const cliArgs = [cliPath, apply ? "apply" : "plan"];
if (apply) cliArgs.push("--yes");
if (throughArg) cliArgs.push(throughArg);
if (deferredArg) cliArgs.push(deferredArg);
const result = spawnSync(process.execPath, cliArgs, { stdio: "inherit", env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
