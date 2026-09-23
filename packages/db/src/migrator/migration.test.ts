import { resolve } from "node:path";
import type { Client } from "pg";
import { describe, expect, it } from "vitest";
import { deriveCatalogProbes, deriveEffectiveCatalogProbes } from "./catalog";
import { assertAdoptionRequiredIfNonEmpty } from "./runner";
import { redactCredentials } from "./security";
import {
  lintMigrationDirectory,
  loadMigrations,
  migrationChecksum,
  parseMigrationDirectives,
  sha256,
  splitMigrationStatements,
} from "./migration";
import {
  assertLegacyNetworking0018Crosswalk,
  crosswalkLegacyNetworking0018Steps,
  LEGACY_NETWORKING_FILE_CHECKSUMS,
  LEGACY_NETWORKING_0018_CROSSWALK,
} from "./legacy-networking";

const migrationsDirectory = resolve(__dirname, "../../migrations");

describe("unified migration format", () => {
  it("redacts connection credentials from CLI errors", () => {
    const safe = redactCredentials(
      "could not connect to postgres://runner:s3cr%40t@db.example/app?password=other-secret",
    );
    expect(safe).not.toContain("s3cr%40t");
    expect(safe).not.toContain("other-secret");
    expect(safe).toContain("postgres://[redacted]@db.example/app?password=[redacted]");
  });

  it("refuses a non-empty schema without a migration ledger", async () => {
    const client = {
      async query(sql: string, values?: unknown[]) {
        if (sql.includes("table_name NOT IN")) return { rows: [{ present: true }] };
        if (values?.[0] === "schema_migrations") return { rows: [{ present: false }] };
        throw new Error(`Unexpected guard query: ${sql}`);
      },
    } as unknown as Client;
    await expect(assertAdoptionRequiredIfNonEmpty(client)).rejects.toThrow(/run migrate adopt first/);
  });

  it("allows an empty schema to bootstrap without a ledger", async () => {
    const client = {
      async query() {
        return { rows: [{ present: false }] };
      },
    } as unknown as Client;
    await expect(assertAdoptionRequiredIfNonEmpty(client)).resolves.toBeUndefined();
  });

  it("splits only on explicit breakpoint markers, never on SQL semicolons", () => {
    expect(splitMigrationStatements("SELECT 1; SELECT 2;")).toEqual(["SELECT 1; SELECT 2;"]);
    expect(splitMigrationStatements("SELECT 1;\n--> statement-breakpoint\nSELECT 2;")).toHaveLength(2);
    expect(splitMigrationStatements("SELECT 1;--> statement-breakpoint\nSELECT 2;")).toEqual(["SELECT 1", "SELECT 2;"]);
  });

  it("splits every inline Drizzle boundary in the baseline and networking files", async () => {
    const postgres = await loadMigrations(migrationsDirectory, "postgres");
    for (const id of ["0000", "0012"]) {
      const migration = postgres.find((candidate) => candidate.id === id);
      expect(migration).toBeDefined();
      const markerCount = migration!.source.match(/statement-breakpoint/g)?.length ?? 0;
      expect(markerCount).toBeGreaterThan(0);
      expect(migration!.statements).toHaveLength(markerCount + 1);
    }
  });

  it("records three separate 0010 statements for CockroachDB", async () => {
    const migrations = await loadMigrations(migrationsDirectory, "cockroach");
    const migration = migrations.find((candidate) => candidate.id === "0010");
    expect(migration?.directives.transaction).toBe("per-statement");
    expect(migration?.statements).toHaveLength(3);
    expect(migration?.statements[0]).toContain("SET TIME ZONE 'UTC'");
    expect(migration?.statements[1]).toContain('ALTER TABLE "registrations"');
    expect(migration?.statements[2]).toContain('ALTER TABLE "access_check_ins"');
    expect(migration?.directives.verify).toHaveLength(1);
    expect(migration?.directives.verify[0]).toContain("datetime_precision = 3");
  });

  it("selects Cockroach-only and override migration variants by number", async () => {
    const postgres = await loadMigrations(migrationsDirectory, "postgres");
    const cockroach = await loadMigrations(migrationsDirectory, "cockroach");
    expect(postgres.find((migration) => migration.id === "0017")).toBeUndefined();
    expect(cockroach.find((migration) => migration.id === "0017")?.variant).toBe("cockroach");
    expect(cockroach.find((migration) => migration.id === "0017")?.directives.deferrable).toBe(true);
    expect(cockroach.find((migration) => migration.id === "0017")?.directives.deferUnless).toContain("NOT EXISTS");
    expect(postgres.find((migration) => migration.id === "0018")?.variant).toBe("shared");
    expect(cockroach.find((migration) => migration.id === "0018")?.variant).toBe("cockroach");
  });

  it("keeps historical shared 0018 checksum compatible after adding metadata", async () => {
    const postgres = await loadMigrations(migrationsDirectory, "postgres");
    const migration = postgres.find((candidate) => candidate.id === "0018");
    expect(migration).toBeDefined();
    expect(migrationChecksum(migration!.source)).toBe(LEGACY_NETWORKING_0018_CROSSWALK.legacyFileChecksum);
  });

  it("preserves every existing networking_migrations file checksum", async () => {
    const postgres = await loadMigrations(migrationsDirectory, "postgres");
    const cockroach = await loadMigrations(migrationsDirectory, "cockroach");
    for (const [key, checksum] of Object.entries(LEGACY_NETWORKING_FILE_CHECKSUMS)) {
      const [id, variant] = key.split(":");
      const files = variant === "cockroach" ? cockroach : postgres;
      expect(files.find((migration) => migration.id === id)?.checksum).toBe(checksum);
    }
  });

  it("maps interrupted old Cockroach 0018 step rows only through fixed checksums", async () => {
    const cockroach = await loadMigrations(migrationsDirectory, "cockroach");
    const postgres = await loadMigrations(migrationsDirectory, "postgres");
    const migration = cockroach.find((candidate) => candidate.id === "0018");
    const legacyFile = postgres.find((candidate) => candidate.id === "0018");
    expect(migration).toBeDefined();
    expect(legacyFile).toBeDefined();
    assertLegacyNetworking0018Crosswalk(migration!);

    // Reproduce the immutable 1.1 shim byte-for-byte: filter empty raw chunks,
    // preserve leading newlines/whitespace, then hash each chunk without trim.
    const legacySource = legacyFile!.source
      .split(/(?<=\n)/)
      .filter((line) => !/^\s*--\s*migrate:/i.test(line))
      .join("");
    const historicalChecksums = legacySource
      .split(";")
      .filter((statement) => statement.trim())
      .map(sha256);
    expect(historicalChecksums).toEqual(
      LEGACY_NETWORKING_0018_CROSSWALK.steps.map((step) => step.legacyChecksum),
    );

    const fixture = [0, 2, 5].map((stepIndex) => ({
      name: `0018_networking_spaces.sql:step:${stepIndex}`,
      checksum: LEGACY_NETWORKING_0018_CROSSWALK.steps[stepIndex].legacyChecksum,
    }));
    const mapped = crosswalkLegacyNetworking0018Steps(migration!, undefined, fixture);
    expect(mapped.map((step) => step.stepIndex)).toEqual([0, 2, 5]);
    expect(mapped[0]?.variantChecksum).toBe(LEGACY_NETWORKING_0018_CROSSWALK.steps[0].variantChecksum);
    expect(() => crosswalkLegacyNetworking0018Steps(migration!, undefined, [
      { ...fixture[0], checksum: "0".repeat(64) },
    ])).toThrow(/fixed provenance/);
  });

  it("derives stable catalog probes for the Cockroach 0018 DDL", async () => {
    const cockroach = await loadMigrations(migrationsDirectory, "cockroach");
    const migration = cockroach.find((candidate) => candidate.id === "0018");
    expect(migration).toBeDefined();
    const probes = deriveCatalogProbes(migration!).filter((probe) => "kind" in probe);
    expect(probes).toContainEqual(expect.objectContaining({ kind: "table", name: "networking_spaces" }));
    expect(probes).toContainEqual(expect.objectContaining({ kind: "index", name: "networking_spaces_event_name_key", table: "networking_spaces" }));
    expect(probes).toContainEqual(expect.objectContaining({ kind: "column", name: "space_id", table: "networking_tables" }));
    expect(probes).toContainEqual(expect.objectContaining({ kind: "constraint", name: "networking_tables_two_people_check", table: "networking_tables" }));
  });

  it("declares complete catalog probes for the historical multi-statement networking files", async () => {
    const postgres = await loadMigrations(migrationsDirectory, "postgres");
    const probesById = new Map(postgres.map((migration) => [
      migration.id,
      deriveCatalogProbes(migration).filter((probe) => "kind" in probe && probe.kind !== "extension"),
    ]));

    expect(probesById.get("0015")).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "column", name: "second_factor_verified_at", table: "networking_sessions", source: "manifest" }),
      expect.objectContaining({ kind: "table", name: "networking_second_factors", source: "manifest" }),
    ]));
    expect(probesById.get("0016")).toHaveLength(3);
    expect(probesById.get("0018")).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "index", name: "networking_tables_event_name_key", expectedPresent: false, source: "manifest" }),
      expect.objectContaining({ kind: "constraint", name: "networking_tables_two_people_check", source: "manifest" }),
    ]));
    expect(probesById.get("0019")).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "index", name: "networking_messages_sender_created_idx", table: "networking_messages", source: "manifest" }),
      expect.objectContaining({ kind: "index", name: "networking_notifications_unread_idx", table: "networking_notifications", source: "manifest" }),
      expect.objectContaining({ kind: "index", name: "networking_meetings_requester_start_idx", table: "networking_meetings", source: "manifest" }),
      expect.objectContaining({ kind: "index", name: "networking_meetings_recipient_start_idx", table: "networking_meetings", source: "manifest" }),
    ]));
  });

  it("declares every DDL object in the earlier unmarked multi-statement migrations", async () => {
    const postgres = await loadMigrations(migrationsDirectory, "postgres");
    const probesById = new Map(postgres.map((migration) => [
      migration.id,
      deriveCatalogProbes(migration).filter((probe) => "kind" in probe && probe.kind !== "extension"),
    ]));
    const names = (id: string) => probesById.get(id)?.map((probe) => `${probe.kind}:${probe.table ?? ""}:${probe.name}`).sort();

    expect(names("0001")).toEqual(expect.arrayContaining([
      "index:email_templates:email_template_registration_uniq",
      "index:email_templates:email_template_abstract_uniq",
      "index:abstracts:abstracts_event_id_author_email_normalized_key",
      "index:email_logs:email_logs_registration_trigger_active_key",
      "index:email_logs:email_logs_abstract_submission_ack_active_key",
      "index:email_logs:email_logs_template_recipient_trigger_active_key",
      "index:outbox_events:outbox_events_dedupe_key_key",
      "index:registrations:registrations_access_type_ids_inverted_idx",
    ]));
    expect(names("0001")).toHaveLength(8);
    expect(names("0003")).toEqual(expect.arrayContaining([
      "column:email_logs:dedupe_key",
      "index:email_logs:email_logs_dedupe_key_active_key",
    ]));
    expect(names("0003")).toHaveLength(2);
    expect(names("0005")).toEqual(expect.arrayContaining([
      "column:certificate_templates:scope",
      "constraint:certificate_templates:certificate_templates_scope_check",
      "column:certificate_templates:allowed_abstract_final_types",
    ]));
    expect(names("0005")).toHaveLength(3);
    expect(names("0007")).toEqual(expect.arrayContaining([
      "column:forms:success_translations",
      "column:abstract_themes:translations",
      "column:abstract_config:languages",
    ]));
    expect(names("0007")).toHaveLength(3);
    expect(names("0013")).toEqual(expect.arrayContaining([
      "table::networking_embeddings",
      "index:networking_embeddings:networking_embeddings_profile_kind_model_key",
      "index:networking_embeddings:networking_embeddings_event_kind_model_idx",
      "table::networking_embedding_jobs",
      "index:networking_embedding_jobs:networking_embedding_jobs_pending_idx",
    ]));
    expect(names("0013")).toHaveLength(5);
  });

  it("uses the final migration state for catalog checks when later DDL replaces an object", async () => {
    const cockroach = await loadMigrations(migrationsDirectory, "cockroach");
    const effective = deriveEffectiveCatalogProbes(cockroach);
    const droppedIndex = [...effective.values()].flat().find((probe) =>
      "kind" in probe && probe.kind === "index" && probe.name === "networking_tables_event_name_key",
    );
    expect(droppedIndex).toEqual(expect.objectContaining({ migrationId: "0018", expectedPresent: false }));
    expect(effective.get("0012")?.some((probe) =>
      "kind" in probe && probe.kind === "index" && probe.name === "networking_tables_event_name_key",
    )).toBe(false);
  });

  it("requires a declared transaction mode and valid deferral condition", () => {
    expect(() => parseMigrationDirectives("CREATE TABLE t(id int);", "test.sql")).toThrow(/transaction directive/);
    expect(() => parseMigrationDirectives(
      '-- migrate: transaction per-file\n-- migrate: deferrable\nCREATE TABLE t(id int);',
      "test.sql",
    )).toThrow(/must declare defer-unless/);
    expect(() => parseMigrationDirectives(
      '-- migrate: transaction per-file\nCREATE TABLE t(id int);\n-- migrate: idempotent',
      "test.sql",
    )).toThrow(/top of the file/);
  });

  it("passes static lint for all shared and Cockroach migration files", async () => {
    expect(await lintMigrationDirectory(migrationsDirectory)).toEqual([]);
  });
});
