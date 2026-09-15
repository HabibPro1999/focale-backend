#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import pg from "pg";

const args = new Set(process.argv.slice(2));
const throughArg = [...args].find((arg) => arg.startsWith("--through="));
if (throughArg && !/^--through=\d{4}$/.test(throughArg))
  throw new Error("Use --through=NNNN");
const through = throughArg ? Number(throughArg.slice(10)) : Infinity;
const migrationIncluded = (name) =>
  /^\d{4}_.*\.sql$/.test(name) &&
  Number(name.slice(0, 4)) >= 12 &&
  Number(name.slice(0, 4)) <= through;
const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
const names = (await readdir(directory)).filter(migrationIncluded).sort();
const cockroachNames = (await readdir(directory + "cockroach/"))
  .filter(migrationIncluded)
  .sort()
  .map((name) => "cockroach/" + name);
if (!args.has("--apply")) {
  console.log("Networking migration plan (no database changes):");
  for (const name of names) console.log(name);
  for (const name of cockroachNames) console.log(`CockroachDB only: ${name}`);
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
  if (cockroach) names.push(...cockroachNames);
  names.sort((a, b) => a.split("/").at(-1).localeCompare(b.split("/").at(-1)));
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
      const baseline = await readFile(directory + name, "utf8");
      // This known baseline contains only SET and two simple ALTER statements.
      // CockroachDB requires each column-type rewrite outside a multi-statement transaction.
      if (cockroach && name === "0010_checkin_timestamptz.sql") {
        for (const statement of baseline
          .split(";")
          .filter((value) => value.trim()))
          await client.query(statement);
      } else {
        await client.query(baseline);
      }
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
    if (name.startsWith("cockroach/")) {
      // Feature enablement is a DB prerequisite, never changed implicitly here.
      const enabled = (
        await client.query("SHOW CLUSTER SETTING feature.vector_index.enabled")
      ).rows[0];
      if (
        !Object.values(enabled).some(
          (value) => value === true || value === "true" || value === "on",
        )
      )
        throw new Error(
          "CockroachDB vector indexes must be enabled by the database administrator",
        );
      const populated = (
        await client.query("SELECT 1 FROM networking_embeddings LIMIT 1")
      ).rows.length;
      if (populated)
        throw new Error(
          "Vector index backfill on non-empty CockroachDB tables requires a planned maintenance window; sql_safe_updates is preserved",
        );
    }
    const apply = async (key, sql, hash) => {
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO networking_migrations(name,checksum) VALUES($1,$2)",
          [key, hash],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    };
    if (cockroach && name === "0018_networking_spaces.sql") {
      // This fixed migration contains only simple statements (no procedural SQL).
      // Commit each schema change before referencing its new columns. Step records
      // make interrupted upgrades resumable without altering the original checksum.
      const statements = source
        .split(";")
        .filter((statement) => statement.trim());
      for (const [index, statement] of statements.entries()) {
        const key = `${name}:step:${index}`;
        const hash = createHash("sha256").update(statement).digest("hex");
        const applied = (
          await client.query(
            "SELECT checksum FROM networking_migrations WHERE name=$1",
            [key],
          )
        ).rows[0];
        if (applied) {
          if (applied.checksum !== hash)
            throw new Error(
              `Previously applied migration step changed: ${key}`,
            );
          continue;
        }
        // CockroachDB can retain DDL from a failed multi-statement transaction.
        // Reconcile that known partial state while leaving sql_safe_updates enabled.
        const guarded = statement
          .replace(
            "CREATE TABLE networking_spaces",
            "CREATE TABLE IF NOT EXISTS networking_spaces",
          )
          .replace(/CREATE (UNIQUE )?INDEX /, "CREATE $1INDEX IF NOT EXISTS ")
          .replace("ADD COLUMN space_id", "ADD COLUMN IF NOT EXISTS space_id")
          .replace(
            "ADD CONSTRAINT networking_tables_two_people_check",
            "ADD CONSTRAINT IF NOT EXISTS networking_tables_two_people_check",
          )
          .replace(
            "SELECT id,event_id,name,kind,1,location,active FROM networking_tables",
            "SELECT id,event_id,name,kind,1,location,active FROM networking_tables ON CONFLICT (id) DO NOTHING",
          )
          .replace(
            "UPDATE networking_tables SET space_id=id, capacity=2",
            "UPDATE networking_tables SET space_id=coalesce(space_id,id), capacity=2 WHERE space_id IS NULL OR capacity<>2",
          );
        await apply(key, guarded, hash);
      }
      await apply(name, "SELECT 1", checksum);
    } else {
      await apply(name, source, checksum);
    }
    console.log(`Applied ${name}`);
  }
  console.log(
    `Networking schema ready (${cockroach ? "CockroachDB native vectors" : "PostgreSQL pgvector"}). Small events use exact scoring; large events use a bounded candidate union with exact reranking. CockroachDB uses the event-scoped cosine index; PostgreSQL retains exact distance scans.`,
  );
} finally {
  await client.end();
}
