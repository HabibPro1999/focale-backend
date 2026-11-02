import type { Client } from "pg";
import { describe, expect, it } from "vitest";
import { deriveCatalogProbes, inspectCatalogProbes, inspectMigrationCatalog, prismaForeignKeyName } from "./catalog";
import {
  defaultMigrationsDirectory,
  loadMigrations,
  migrationChecksum,
  parseMigrationDirectives,
  splitMigrationStatements,
  type MigrationDefinition,
} from "./migration";
import type { CatalogObjectProbe } from "./types";

function sqlFixture(source: string): MigrationDefinition {
  return {
    id: "0099",
    name: "0099_catalog_fixture.sql",
    variant: "shared",
    filePath: "0099_catalog_fixture.sql",
    source,
    checksum: migrationChecksum(source),
    directives: parseMigrationDirectives(source, "0099_catalog_fixture.sql"),
    statements: splitMigrationStatements(source),
  };
}

function objectProbes(migration: MigrationDefinition): CatalogObjectProbe[] {
  return deriveCatalogProbes(migration).filter((probe): probe is CatalogObjectProbe => !("query" in probe));
}

describe("migration catalog verification", () => {
  it("runs probes sequentially on a single PostgreSQL client", async () => {
    let activeQueries = 0;
    let maximumActiveQueries = 0;
    const client = {
      async query() {
        activeQueries += 1;
        maximumActiveQueries = Math.max(maximumActiveQueries, activeQueries);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeQueries -= 1;
        return { rows: [{ passed: true }] };
      },
    } as unknown as Client;
    const migration: MigrationDefinition = {
      id: "9999",
      name: "catalog_probe_fixture",
      variant: "shared",
      filePath: "9999_catalog_probe_fixture.sql",
      source: "fixture",
      checksum: "a".repeat(64),
      directives: {
        transaction: "per-file",
        requiresExtensions: [],
        idempotent: false,
        deferrable: false,
        verify: ["SELECT true AS passed", "SELECT true AS passed"],
      },
      statements: [],
    };

    const report = await inspectMigrationCatalog(client, "postgres", migration);

    expect(report.state).toBe("all");
    expect(maximumActiveQueries).toBe(1);
  });
});

describe("prismaForeignKeyName", () => {
  it("names a key <table>_<columns>_fkey, as the legacy Prisma migrations do", () => {
    expect(prismaForeignKeyName("users", ["client_id"])).toBe("users_client_id_fkey");
    expect(prismaForeignKeyName("abstract_committee_memberships", ["user_id"])).toBe(
      "abstract_committee_memberships_user_id_fkey",
    );
    // The implicit many-to-many table keeps its capitalized columns.
    expect(prismaForeignKeyName("_AccessPrerequisites", ["A"])).toBe("_AccessPrerequisites_A_fkey");
  });

  it("joins the columns of a multi-column key in order", () => {
    expect(prismaForeignKeyName("short", ["pa", "pb"])).toBe("short_pa_pb_fkey");
  });

  // Expected names are Prisma 7.2.0's own `migrate diff` output for these keys.
  it("cuts the part before _fkey to 58 bytes so the name fits in 63", () => {
    const c = (length: number) => "c".repeat(length);
    expect(prismaForeignKeyName("t", [c(53), "b"])).toBe(`t_${c(53)}_b_fkey`); // 57 bytes before _fkey
    expect(prismaForeignKeyName("u", [c(54), "b"])).toBe(`u_${c(54)}_b_fkey`); // exactly 58: no cut
    expect(prismaForeignKeyName("v", [c(55), "b"])).toBe(`v_${c(55)}__fkey`); // 59: cut mid-name
    expect(prismaForeignKeyName("child_table_with_a_long_name", ["parent_a_column_with_a_fairly_long_name", "parent_b"])).toBe(
      "child_table_with_a_long_name_parent_a_column_with_a_fairly_fkey",
    );
    // A cut inside a multi-byte character backs off to the character boundary.
    expect(prismaForeignKeyName("m", [`${c(55)}é`, "b"])).toBe(`m_${c(55)}_fkey`);
  });
});

describe("catalog probes derived from DDL", () => {
  it("probes every column a CREATE TABLE declares, skipping table-level elements", () => {
    const migration = sqlFixture([
      "-- migrate: transaction per-file",
      'CREATE TABLE "clients" (',
      '\t"id" text PRIMARY KEY NOT NULL,',
      `\t"enabled_modules" text[] DEFAULT '{"pricing","registrations"}',`,
      "\tcapacity integer NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 500),",
      `\tkind text NOT NULL DEFAULT 'TABLE' CHECK (kind IN ('TABLE','STAND')),`,
      '\t"A" text NOT NULL,',
      '\tCONSTRAINT "clients_kind_key" UNIQUE ("kind"),',
      '\tPRIMARY KEY ("id"),',
      '\tFOREIGN KEY ("A") REFERENCES "other"("id"),',
      '\tCHECK ("capacity" > 0)',
      ");",
    ].join("\n"));
    expect(objectProbes(migration).map((probe) => `${probe.kind}:${probe.table ?? ""}:${probe.name}`)).toEqual([
      "table::clients",
      "column:clients:id",
      "column:clients:enabled_modules",
      "column:clients:capacity",
      "column:clients:kind",
      "column:clients:A",
    ]);
  });

  it("probes every label of a CREATE TYPE ... AS ENUM, and none of a later ADD VALUE", () => {
    const migration = sqlFixture([
      "-- migrate: transaction per-file",
      `CREATE TYPE "public"."EmailStatus" AS ENUM('QUEUED', 'SENT', 'it''s');--> statement-breakpoint`,
      `ALTER TYPE "EmailStatus" ADD VALUE IF NOT EXISTS 'UNCERTAIN';`,
    ].join("\n"));
    expect(objectProbes(migration).map((probe) => `${probe.kind}:${probe.table ?? ""}:${probe.name}`)).toEqual([
      "type::EmailStatus",
      "label:EmailStatus:QUEUED",
      "label:EmailStatus:SENT",
      "label:EmailStatus:it's",
    ]);
  });

  it("accepts a foreign key under Prisma's default name as well as the declared one", () => {
    const migration = sqlFixture([
      "-- migrate: transaction per-file",
      `ALTER TABLE "users" ADD CONSTRAINT "users_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null;--> statement-breakpoint`,
      `ALTER TABLE "short" ADD CONSTRAINT "short_parent_fk" FOREIGN KEY ("pa", "pb") REFERENCES "parent"("a", "b");--> statement-breakpoint`,
      `ALTER TABLE "events" ADD CONSTRAINT "events_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id");--> statement-breakpoint`,
      `ALTER TABLE "certificate_templates" ADD CONSTRAINT "certificate_templates_scope_check" CHECK ("scope" IN ('REGISTRATION', 'ABSTRACT'));`,
    ].join("\n"));
    expect(objectProbes(migration)).toEqual([
      expect.objectContaining({ kind: "constraint", table: "users", name: "users_client_id_clients_id_fk", aliases: ["users_client_id_fkey"] }),
      expect.objectContaining({ kind: "constraint", table: "short", name: "short_parent_fk", aliases: ["short_pa_pb_fkey"] }),
      // Already Prisma's name, and a CHECK constraint: no alias.
      expect.not.objectContaining({ aliases: expect.anything() }),
      expect.not.objectContaining({ aliases: expect.anything() }),
    ]);
  });

  // The exact list is checked against Prisma's generated legacy schema in
  // tests/helpers/legacy-prisma.test.ts.
  it("gives every 0000 foreign key Prisma's name as its alias", async () => {
    for (const engine of ["postgres", "cockroach"] as const) {
      const migrations = await loadMigrations(defaultMigrationsDirectory(), engine);
      const keys = objectProbes(migrations.find((migration) => migration.id === "0000")!).filter(
        (probe) => probe.kind === "constraint",
      );
      expect(keys).toHaveLength(43);
      for (const key of keys) {
        expect(key.name).toMatch(new RegExp(`^${key.table}_.+_fk$`));
        expect(key.aliases).toEqual([expect.stringMatching(new RegExp(`^${key.table}_[A-Za-z_]+_fkey$`))]);
      }
      expect(keys.find((key) => key.name === "users_client_id_clients_id_fk")?.aliases).toEqual(["users_client_id_fkey"]);
      expect(keys.find((key) => key.name === "_AccessPrerequisites_A_event_access_id_fk")?.aliases).toEqual([
        "_AccessPrerequisites_A_fkey",
      ]);
    }
  });

  it("matches a constraint probe by its declared name or an alias", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const client = {
      async query(text: string, values: unknown[]) {
        queries.push({ text, values });
        return { rows: [{ present: true }] };
      },
    } as unknown as Client;
    const migration = sqlFixture([
      "-- migrate: transaction per-file",
      `ALTER TABLE "users" ADD CONSTRAINT "users_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "clients"("id");`,
    ].join("\n"));
    const report = await inspectCatalogProbes(client, "cockroach", migration, deriveCatalogProbes(migration));
    expect(report.state).toBe("all");
    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toMatch(/constraint_name IN \(\$2, \$3\)/);
    expect(queries[0]!.values).toEqual(["users", "users_client_id_clients_id_fk", "users_client_id_fkey"]);
  });
});
