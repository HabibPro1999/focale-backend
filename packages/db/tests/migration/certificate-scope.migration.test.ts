import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { assertSafeTestDatabaseUrl, dbTestsEnabled } from "../helpers/test-env";

// Ownership note: schema.migration.test.ts (0000/0001 assertions) belongs to
// another agent; this file only covers 0005_certificate_template_scope.sql
// (H2 scope + allowed abstract final types), applied on top of the same
// migration set.

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

function migrationFiles(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(`${MIGRATIONS_DIR}/${name}`, "utf8"),
    }));
}

function scratchUrl(base: string): { url: string; dbName: string; adminUrl: string } {
  const parsed = new URL(base);
  const baseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const dbName = `${baseName}_mig_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new URL(base);
  admin.pathname = "/postgres";
  const scratch = new URL(base);
  scratch.pathname = `/${dbName}`;
  return { url: scratch.toString(), dbName, adminUrl: admin.toString() };
}

describe.runIf(dbTestsEnabled())(
  "migration tier: 0005_certificate_template_scope (H2)",
  () => {
    let dbName: string;
    let adminUrl: string;
    let client: Client;

    beforeAll(async () => {
      const scratch = scratchUrl(process.env.TEST_DATABASE_URL as string);
      dbName = scratch.dbName;
      adminUrl = scratch.adminUrl;
      const url = scratch.url;
      assertSafeTestDatabaseUrl(url);

      const admin = new Client({ connectionString: adminUrl });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${dbName}"`);
      await admin.end();

      client = new Client({ connectionString: url });
      await client.connect();
      for (const { sql } of migrationFiles()) {
        await client.query(sql);
      }

      // Minimal client + event row so certificate_templates' NOT NULL FK is
      // satisfiable by the inserts below.
      await client.query(
        `INSERT INTO "clients" ("id", "name", "updated_at") VALUES ('cli-1', 'Client', now())`,
      );
      await client.query(
        `INSERT INTO "events" ("id", "client_id", "name", "slug", "start_date", "end_date", "updated_at")
         VALUES ('evt-1', 'cli-1', 'Event', 'event', now(), now(), now())`,
      );
    }, 60000);

    afterAll(async () => {
      if (client) await client.end();
      const admin = new Client({ connectionString: adminUrl });
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    });

    it("applies 0005_certificate_template_scope.sql", () => {
      expect(migrationFiles().map((f) => f.name)).toContain(
        "0005_certificate_template_scope.sql",
      );
    });

    it("adds certificate_templates.scope as NOT NULL text, default 'BOTH'", async () => {
      const { rows } = await client.query<{
        is_nullable: string;
        data_type: string;
        column_default: string | null;
      }>(
        `SELECT is_nullable, data_type, column_default FROM information_schema.columns
         WHERE table_name = 'certificate_templates' AND column_name = 'scope'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].data_type).toBe("text");
      expect(rows[0].is_nullable).toBe("NO");
      expect(rows[0].column_default).toContain("BOTH");
    });

    it("adds a nullable allowed_abstract_final_types AbstractFinalType[] column, no default", async () => {
      const { rows } = await client.query<{
        is_nullable: string;
        udt_name: string;
        column_default: string | null;
      }>(
        `SELECT is_nullable, udt_name, column_default FROM information_schema.columns
         WHERE table_name = 'certificate_templates' AND column_name = 'allowed_abstract_final_types'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].is_nullable).toBe("YES");
      expect(rows[0].udt_name).toBe("_AbstractFinalType");
      expect(rows[0].column_default).toBeNull();
    });

    it("a template inserted without scope defaults to 'BOTH' with no allowed final types", async () => {
      await client.query(
        `INSERT INTO "certificate_templates"
           ("id", "event_id", "name", "template_url", "template_width", "template_height", "updated_at")
         VALUES ('tpl-default', 'evt-1', 'Default Cert', '', 0, 0, now())`,
      );
      const { rows } = await client.query<{
        scope: string;
        allowed_abstract_final_types: string[] | null;
      }>(
        `SELECT scope, allowed_abstract_final_types FROM "certificate_templates" WHERE id = 'tpl-default'`,
      );
      expect(rows[0].scope).toBe("BOTH");
      expect(rows[0].allowed_abstract_final_types).toBeNull();
    });

    it("the scope CHECK constraint rejects a value outside REGISTRATION/ABSTRACT/BOTH", async () => {
      await expect(
        client.query(
          `INSERT INTO "certificate_templates"
             ("id", "event_id", "name", "template_url", "template_width", "template_height", "scope", "updated_at")
           VALUES ('tpl-bad-scope', 'evt-1', 'Bad Cert', '', 0, 0, 'EVERYONE', now())`,
        ),
      ).rejects.toThrow(/violates check constraint/i);
    });

    it("accepts an explicit scope + allowed final types", async () => {
      await client.query(
        `INSERT INTO "certificate_templates"
           ("id", "event_id", "name", "template_url", "template_width", "template_height", "scope", "allowed_abstract_final_types", "updated_at")
         VALUES ('tpl-abstract', 'evt-1', 'Abstract Cert', '', 0, 0, 'ABSTRACT', ARRAY['POSTER']::"AbstractFinalType"[], now())`,
      );
      const { rows } = await client.query<{
        scope: string;
        // node-pg doesn't know how to parse a custom enum[] OID, so this
        // comes back as the raw Postgres array literal, not a JS array.
        allowed_abstract_final_types: string;
      }>(
        `SELECT scope, allowed_abstract_final_types FROM "certificate_templates" WHERE id = 'tpl-abstract'`,
      );
      expect(rows[0].scope).toBe("ABSTRACT");
      expect(rows[0].allowed_abstract_final_types).toBe("{POSTER}");
    });

    it("does not introduce a new enum type (stays at 19 total)", async () => {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = 'public' AND t.typtype = 'e'`,
      );
      expect(Number(rows[0].n)).toBe(19);
    });
  },
);
