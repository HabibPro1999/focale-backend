import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultMigrationsDirectory, loadMigrations } from "../migrator/migration";
import { DATA_CHECKS } from "./cutover-preflight-checks";
import { modifiedTables } from "./cutover-preflight";
import { declaredForeignKeys, prismaForeignKeyName, summarizeForeignKeys } from "./cutover-preflight-reads";

describe("cutover preflight data checks", () => {
  it("cite lines that still hold the predicate each check mirrors", async () => {
    for (const check of DATA_CHECKS) {
      const lines = (await readFile(join(defaultMigrationsDirectory(), check.file), "utf8")).split("\n");
      expect(check.file.startsWith(`${check.migrationId}_`)).toBe(true);
      for (const citation of check.citations) {
        expect(lines[citation.line - 1], `${check.file}:${citation.line}`).toContain(citation.fragment);
      }
    }
  });

  it("cover every migration that changes existing rows, except 0018 (networking tables, listed with their counts)", async () => {
    for (const engine of ["postgres", "cockroach"] as const) {
      const migrations = await loadMigrations(defaultMigrationsDirectory(), engine);
      const modifying = Object.fromEntries(
        migrations.map((migration) => [migration.id, modifiedTables(migration)]).filter(([, tables]) => tables.length),
      );
      expect(modifying).toEqual({
        "0006": ["abstract_themes"],
        "0010": ["registrations", "access_check_ins"],
        "0011": ["registrations"],
        "0018": ["networking_tables", "networking_profiles", "networking_reservations"],
        "0030": ["registrations"],
        "0033": ["abstract_code_sequences"],
      });
      const checked = new Set(DATA_CHECKS.map((check) => check.migrationId));
      expect(Object.keys(modifying).filter((id) => !checked.has(id))).toEqual(["0018"]);
    }
  });

  it("ignore upsert branches, foreign-key actions and comments when listing modified tables", () => {
    expect(modifiedTables({
      source: [
        "-- UPDATE commented_out SET x = 1",
        'ALTER TABLE "a" ADD CONSTRAINT "a_b_fk" FOREIGN KEY ("b") REFERENCES "b"("id") ON DELETE cascade ON UPDATE cascade;',
        "INSERT INTO c (id) VALUES (1) ON CONFLICT (id) DO",
        "UPDATE SET id = excluded.id;",
        'UPDATE "public"."d" SET x = 1;',
      ].join("\n"),
    })).toEqual(["d"]);
  });
});

describe("cutover preflight foreign-key summary", () => {
  it("reads the 43 named foreign keys of 0000 with their columns", async () => {
    const migrations = await loadMigrations(defaultMigrationsDirectory(), "postgres");
    const declared = declaredForeignKeys(migrations.filter((migration) => migration.id === "0000"));
    expect(declared).toHaveLength(43);
    expect(declared[0]).toEqual({ migrationId: "0000", table: "users", name: "users_client_id_clients_id_fk", columns: ["client_id"] });
    expect(prismaForeignKeyName("_AccessPrerequisites", ["A"])).toBe("_AccessPrerequisites_A_fkey");
  });

  it("counts each declared key by its declared name, Prisma's default name, or as missing", () => {
    const declared = [
      { migrationId: "0000", table: "users", name: "users_client_id_clients_id_fk", columns: ["client_id"] },
      { migrationId: "0000", table: "events", name: "events_client_id_clients_id_fk", columns: ["client_id"] },
      { migrationId: "0000", table: "forms", name: "forms_event_id_events_id_fk", columns: ["event_id"] },
    ];
    const present = [
      { table_name: "users", constraint_name: "users_client_id_clients_id_fk" },
      { table_name: "events", constraint_name: "events_client_id_fkey" },
      { table_name: "audit", constraint_name: "audit_custom_name" },
    ];
    expect(summarizeForeignKeys(present, declared)).toEqual({
      total: 3,
      prismaNamed: 1,
      drizzleNamed: 1,
      otherNamed: 1,
      byMigration: [{ migrationId: "0000", declared: 3, byDeclaredName: 1, byPrismaName: 1, missing: ["forms_event_id_events_id_fk"] }],
    });
  });
});
