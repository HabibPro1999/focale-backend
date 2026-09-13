#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import pg from "pg";

const args = new Set(process.argv.slice(2));
const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
const names = (await readdir(directory))
  .filter(
    (name) => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) >= 12,
  )
  .sort();
if (!args.has("--apply")) {
  console.log("Networking migration plan (no database changes):");
  for (const name of names) console.log(name);
  console.log(
    "Apply with DATABASE_URL set and --apply. --bootstrap-test is restricted to an empty local disposable test database.",
  );
  process.exit(0);
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const url = new URL(process.env.DATABASE_URL);
const bootstrap = args.has("--bootstrap-test");
if (
  bootstrap &&
  (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/(focale_)?networking_test_[a-z0-9_]+$/.test(url.pathname))
)
  throw new Error(
    "Bootstrap requires a local dedicated networking_test database",
  );
const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
try {
  const version = (await client.query("SELECT version() AS version")).rows[0]
    .version;
  const cockroach = /CockroachDB/.test(version);
  if (bootstrap) {
    const tables = (
      await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
      )
    ).rows;
    if (tables.length)
      throw new Error("Refusing to bootstrap a nonempty database");
    for (const name of (await readdir(directory))
      .filter((name) => /^00(0\d|1[01])_.*\.sql$/.test(name))
      .sort()) {
      await client.query(await readFile(directory + name, "utf8"));
      console.log(`Applied test baseline ${name}`);
    }
  }
  if (!cockroach) await client.query("CREATE EXTENSION IF NOT EXISTS vector");
  await client.query(
    "CREATE TABLE IF NOT EXISTS networking_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const name of names) {
    const source = await readFile(directory + name, "utf8");
    const checksum = createHash("sha256").update(source).digest("hex");
    const previous = (
      await client.query(
        "SELECT checksum FROM networking_migrations WHERE name=$1",
        [name],
      )
    ).rows[0];
    if (previous) {
      if (previous.checksum !== checksum)
        throw new Error(`Previously applied migration changed: ${name}`);
      console.log(`Already applied ${name}`);
      continue;
    }
    await client.query("BEGIN");
    try {
      await client.query(source);
      await client.query(
        "INSERT INTO networking_migrations(name,checksum) VALUES($1,$2)",
        [name, checksum],
      );
      await client.query("COMMIT");
      console.log(`Applied ${name}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  console.log(
    `Networking schema ready (${cockroach ? "CockroachDB native vectors" : "PostgreSQL pgvector"}). Vector retrieval is exact and event-filtered; add engine-specific approximate indexes only after measuring recall at event scale.`,
  );
} finally {
  await client.end();
}
