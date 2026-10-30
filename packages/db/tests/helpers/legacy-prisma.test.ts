import { describe, expect, it } from "vitest";
import { defaultMigrationsDirectory, deriveCatalogProbes, loadMigrations } from "../../src/migrator";
import { LEGACY_PRISMA_MIGRATION_NAMES, legacyPrismaStatements, splitSqlScript, toPostgres } from "./legacy-prisma";

const outsideQuotes = (sql: string) => sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, "");

describe("legacy Prisma fixture", () => {
  it("splits into whole statements", () => {
    const statements = legacyPrismaStatements("cockroach");
    for (const statement of statements) expect(statement).toMatch(/^(?:CREATE|ALTER TABLE|INSERT INTO) /);
    expect(statements[0]).toBe('CREATE SCHEMA IF NOT EXISTS "public"');
  });

  it("records main's 31 Prisma migrations, all finished", () => {
    const insert = legacyPrismaStatements("cockroach").find((statement) => statement.startsWith('INSERT INTO "_prisma_migrations"'))!;
    const rows = [...insert.matchAll(/\('[0-9a-f-]{36}', '[0-9a-f]{64}', '([^']+)', '([^']+)', NULL, NULL, '([^']+)', 1\)/g)];
    expect(rows.map(([, , name]) => name)).toEqual([...LEGACY_PRISMA_MIGRATION_NAMES]);
    for (const [, finishedAt, , startedAt] of rows) expect(finishedAt).toBe(startedAt);
  });

  // The same names catalog.ts derives from Prisma's rule (prismaForeignKeyName),
  // checked against what Prisma itself generated.
  it("names every foreign key as 0000's Prisma aliases do, plus 0008's two inline keys", async () => {
    const keys = legacyPrismaStatements("cockroach").flatMap((statement) => {
      const match = /^ALTER TABLE "[^"]+" ADD CONSTRAINT "([^"]+)" FOREIGN KEY/.exec(statement);
      return match ? [match[1]!] : [];
    });
    expect(keys).toHaveLength(45);
    for (const engine of ["postgres", "cockroach"] as const) {
      const migrations = await loadMigrations(defaultMigrationsDirectory(), engine);
      const aliases = deriveCatalogProbes(migrations.find((migration) => migration.id === "0000")!).flatMap((probe) =>
        "query" in probe ? [] : (probe.aliases ?? []),
      );
      expect([...aliases, "committee_invite_tokens_event_id_fkey", "committee_invite_tokens_user_id_fkey"].sort()).toEqual(
        [...keys].sort(),
      );
    }
  });

  it("runs on PostgreSQL with STRING as TEXT and the inverted index as GIN", () => {
    for (const statement of legacyPrismaStatements("postgres")) {
      expect(outsideQuotes(statement)).not.toMatch(/\bSTRING\b|\bINVERTED\b/);
    }
    expect(legacyPrismaStatements("postgres")).toContain(
      'CREATE INDEX "registrations_access_type_ids_inverted_idx" ON "registrations" USING GIN ("access_type_ids")',
    );
  });
});

describe("splitSqlScript", () => {
  it("splits at semicolons outside quotes and comments, and drops the comments", () => {
    const sql = [
      "-- a comment; still a comment",
      `CREATE TABLE "a;b" ("note" STRING DEFAULT 'it''s; fine');`,
      "/* block; comment */ SELECT 1;",
      "SELECT '--not a comment'",
    ].join("\n");
    expect(splitSqlScript(sql)).toEqual([
      `CREATE TABLE "a;b" ("note" STRING DEFAULT 'it''s; fine')`,
      "SELECT 1",
      "SELECT '--not a comment'",
    ]);
  });
});

describe("toPostgres", () => {
  it("rewrites STRING outside quotes only", () => {
    expect(toPostgres(`CREATE TABLE "STRING" ("a" STRING[] DEFAULT ARRAY['STRING']::STRING[], "b" STRING)`)).toBe(
      `CREATE TABLE "STRING" ("a" TEXT[] DEFAULT ARRAY['STRING']::TEXT[], "b" TEXT)`,
    );
    expect(toPostgres(`ALTER TABLE "t" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::STRING`)).toBe(
      `ALTER TABLE "t" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::TEXT`,
    );
  });

  it("makes an inverted index a GIN index", () => {
    expect(toPostgres(`CREATE INVERTED INDEX "t_tags_idx"\n  ON "t" ("tags")`)).toBe(
      `CREATE INDEX "t_tags_idx" ON "t" USING GIN ("tags")`,
    );
  });
});
