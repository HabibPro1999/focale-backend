import type { Client } from "pg";
import type { DatabaseEngine } from "./migration";

export function detectDatabaseEngine(version: string): DatabaseEngine {
  return /CockroachDB/i.test(version) ? "cockroach" : "postgres";
}

export function normalizeAppliedBy(value?: string): string {
  const candidate = value?.trim();
  if (candidate && /^[a-zA-Z0-9._:-]{1,128}$/.test(candidate)) return candidate;
  return "migrator-cli";
}

export async function databaseEngine(client: Client): Promise<DatabaseEngine> {
  const result = await client.query<{ version: string }>("SELECT version() AS version");
  return detectDatabaseEngine(result.rows[0]?.version ?? "");
}

export async function setUtcSession(client: Client): Promise<void> {
  await client.query("SET TIME ZONE 'UTC'");
}
