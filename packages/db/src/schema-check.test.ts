import { describe, expect, it, vi } from "vitest";
import {
  assertSchemaCurrent,
  SchemaNotCurrentError,
  UnadoptedDatabaseError,
  type SchemaCheckClient,
  type SchemaCheckLogger,
} from "./schema-check";
import {
  defaultMigrationsDirectory,
  loadMigrations,
  type DatabaseEngine,
  type SchemaMigrationRecord,
} from "./migrator";

async function currentLedger(engine: DatabaseEngine): Promise<SchemaMigrationRecord[]> {
  const migrations = await loadMigrations(defaultMigrationsDirectory(), engine);
  return migrations.map((migration) => ({
    id: migration.id,
    variant: migration.variant,
    checksum: migration.checksum,
    status: "applied",
    applied_at: new Date(0),
    applied_by: "test",
    evidence: {},
  }));
}

interface FakeSessionOptions {
  engine?: DatabaseEngine;
  zone?: string;
  /** null: the ledger table does not exist. */
  ledger: SchemaMigrationRecord[] | null;
  /** Whether the schema has tables besides the ledger's (default true). */
  applicationTables?: boolean;
}

function fakeSession(options: FakeSessionOptions) {
  let zone = options.zone ?? "UTC";
  const released: unknown[] = [];
  const queries: string[] = [];
  const client = {
    async query(text: string) {
      queries.push(text);
      if (/^SHOW TIME ZONE/i.test(text)) return { rows: [{ TimeZone: zone }] };
      if (/^SET TIME ZONE 'UTC'/i.test(text)) {
        zone = "UTC";
        return { rows: [] };
      }
      if (/SELECT version\(\)/i.test(text)) {
        return {
          rows: [{ version: options.engine === "cockroach" ? "CockroachDB CCL v26.2.5" : "PostgreSQL 16.15" }],
        };
      }
      if (/table_name NOT IN \('schema_migrations'/i.test(text)) {
        return { rows: [{ present: options.applicationTables ?? true }] };
      }
      if (/information_schema\.tables/i.test(text)) return { rows: [{ present: options.ledger !== null }] };
      if (/SELECT EXISTS \(SELECT 1 FROM public\.schema_migrations\)/i.test(text)) {
        return { rows: [{ present: (options.ledger?.length ?? 0) > 0 }] };
      }
      if (/FROM public\.schema_migrations/i.test(text)) return { rows: options.ledger ?? [] };
      throw new Error(`unexpected query: ${text}`);
    },
    release(destroy?: boolean | Error) {
      released.push(destroy);
    },
  };
  return { client: client as unknown as SchemaCheckClient, released, queries };
}

function recordingLogger() {
  const calls: Array<{ level: "info" | "warn" | "error"; message: string; details: object }> = [];
  const logger: SchemaCheckLogger = {
    info: (details, message) => calls.push({ level: "info", message, details }),
    warn: (details, message) => calls.push({ level: "warn", message, details }),
    error: (details, message) => calls.push({ level: "error", message, details }),
  };
  return { logger, calls };
}

describe("assertSchemaCurrent", () => {
  it("skips everything when MIGRATIONS_CHECK=off", async () => {
    const connect = vi.fn();
    const { logger } = recordingLogger();
    const result = await assertSchemaCurrent({ mode: "off", logger, connect });
    expect(result).toEqual({ mode: "off", skipped: true, errors: [], warnings: [] });
    expect(connect).not.toHaveBeenCalled();
  });

  it("passes a current ledger and destroys the inspected session", async () => {
    for (const engine of ["postgres", "cockroach"] as const) {
      const session = fakeSession({ engine, ledger: await currentLedger(engine) });
      const { logger, calls } = recordingLogger();
      const result = await assertSchemaCurrent({ mode: "enforce", logger, connect: async () => session.client });
      expect(result).toEqual({ mode: "enforce", skipped: false, errors: [], warnings: [] });
      // The time zone is read before the ledger helpers pin UTC on the session.
      expect(session.queries[0]).toMatch(/^SHOW TIME ZONE/);
      expect(session.released).toEqual([true]);
      expect(calls.at(-1)).toMatchObject({ level: "info", message: "Database schema is current" });
    }
  });

  it("refuses to start on a pending migration under enforce", async () => {
    const ledger = (await currentLedger("postgres")).filter((record) => record.id !== "0019");
    const { logger, calls } = recordingLogger();
    const check = assertSchemaCurrent({
      mode: "enforce",
      logger,
      connect: async () => fakeSession({ ledger }).client,
    });
    await expect(check).rejects.toBeInstanceOf(SchemaNotCurrentError);
    await expect(
      assertSchemaCurrent({ mode: "enforce", logger, connect: async () => fakeSession({ ledger }).client }),
    ).rejects.toThrow(/Migration 0019 is pending/);
    expect(calls.some((call) => call.level === "error")).toBe(true);
  });

  it("logs and continues under warn", async () => {
    const ledger = (await currentLedger("postgres")).map((record) =>
      record.id === "0005" ? { ...record, checksum: "0".repeat(64) } : record,
    );
    const { logger, calls } = recordingLogger();
    const result = await assertSchemaCurrent({ mode: "warn", logger, connect: async () => fakeSession({ ledger }).client });
    expect(result.errors).toEqual(["Migration 0005 ledger does not match the current shared file"]);
    expect(calls.filter((call) => call.level === "warn").map((call) => call.message)).toEqual([
      "Database schema not current (continuing because MIGRATIONS_CHECK=warn): Migration 0005 ledger does not match the current shared file",
    ]);
  });

  it("only warns for deferred and newer unknown migrations", async () => {
    const ledger = [
      ...(await currentLedger("cockroach")).map((record) =>
        record.id === "0017" ? { ...record, status: "deferred" as const } : record,
      ),
      { ...(await currentLedger("cockroach"))[0]!, id: "9999", checksum: "f".repeat(64) },
    ];
    const { logger } = recordingLogger();
    const result = await assertSchemaCurrent({
      mode: "enforce",
      logger,
      connect: async () => fakeSession({ engine: "cockroach", ledger }).client,
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      "Migration 0017 is deferred",
      "Database has migration 9999 unknown to this runner",
    ]);
  });

  it("fails a missing ledger", async () => {
    const { logger } = recordingLogger();
    await expect(
      assertSchemaCurrent({ mode: "enforce", logger, connect: async () => fakeSession({ ledger: null }).client }),
    ).rejects.toThrow(/Migration ledger is missing/);
  });

  it("asserts the application session is UTC", async () => {
    const ledger = await currentLedger("postgres");
    const { logger } = recordingLogger();
    await expect(
      assertSchemaCurrent({
        mode: "enforce",
        logger,
        connect: async () => fakeSession({ ledger, zone: "America/New_York" }).client,
      }),
    ).rejects.toThrow(/time zone America\/New_York, expected UTC/);
    const etc = await assertSchemaCurrent({
      mode: "enforce",
      logger,
      connect: async () => fakeSession({ ledger, zone: "Etc/UTC" }).client,
    });
    expect(etc.errors).toEqual([]);
  });

  it("is bounded when the database does not answer, and redacts credentials", async () => {
    const { logger } = recordingLogger();
    await expect(
      assertSchemaCurrent({ mode: "enforce", logger, timeoutMs: 50, connect: () => new Promise(() => undefined) }),
    ).rejects.toThrow(/did not finish within 50 ms/);

    const late = fakeSession({ ledger: [] });
    const warned = await assertSchemaCurrent({
      mode: "warn",
      logger,
      timeoutMs: 20,
      connect: () => new Promise((resolve) => setTimeout(() => resolve(late.client), 60)),
    });
    expect(warned.errors).toEqual(["Schema check could not complete: Schema check did not finish within 20 ms"]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(late.released).toEqual([true]);

    const refused = await assertSchemaCurrent({
      mode: "warn",
      logger,
      connect: () => Promise.reject(new Error("connect failed for postgres://admin:hunter2@db.internal:26257/app")),
    });
    expect(refused.errors[0]).toContain("postgres://[redacted]@db.internal");
    expect(refused.errors[0]).not.toContain("hunter2");
  });
});

describe("assertSchemaCurrent in production (the no-ledger guard)", () => {
  const modes = ["enforce", "warn", "off"] as const;

  it("refuses a database with tables but no ledger in every mode, off included", async () => {
    for (const mode of modes) {
      const session = fakeSession({ ledger: null });
      const { logger, calls } = recordingLogger();
      const check = assertSchemaCurrent({ mode, logger, production: true, connect: async () => session.client });
      await expect(check).rejects.toBeInstanceOf(UnadoptedDatabaseError);
      await expect(check).rejects.toThrow(/no migration ledger/);
      expect(session.released).toEqual([true]);
      expect(calls.at(-1)).toMatchObject({
        level: "error",
        details: { migrationsCheck: mode, ledger: "missing" },
        message: "Database has not been adopted by the migrator; refusing to start",
      });
    }
  });

  it("refuses an empty ledger as well, and says how to adopt", async () => {
    const { logger } = recordingLogger();
    const check = assertSchemaCurrent({
      mode: "warn",
      logger,
      production: true,
      connect: async () => fakeSession({ ledger: [] }).client,
    });
    await expect(check).rejects.toMatchObject({ name: "UnadoptedDatabaseError", ledger: "empty" });
    const message = await check.catch((error: Error) => error.message);
    expect(message).toContain("an empty migration ledger");
    expect(message).toContain("RUN_WORKERS=false");
    expect(message).toContain("node packages/db/dist/migrator/cli.js adopt");
    expect(message).toContain('"Production rollout" in packages/db/src/migrator/README.md');
  });

  it("under off, reads only the adoption state of an adopted database", async () => {
    // An adopted ledger with pending migrations: off does not judge those.
    const ledger = (await currentLedger("postgres")).filter((record) => record.id <= "0010");
    const session = fakeSession({ ledger });
    const { logger, calls } = recordingLogger();
    const result = await assertSchemaCurrent({ mode: "off", logger, production: true, connect: async () => session.client });
    expect(result).toEqual({ mode: "off", skipped: true, errors: [], warnings: [] });
    expect(session.queries).toHaveLength(3);
    expect(session.queries.some((query) => /SHOW TIME ZONE|SELECT version\(\)/i.test(query))).toBe(false);
    expect(session.released).toEqual([true]);
    expect(calls).toEqual([{ level: "info", message: "Database schema check skipped", details: { migrationsCheck: "off" } }]);

    // Under warn the same database is adopted, so only the pending migrations are reported.
    const warned = await assertSchemaCurrent({
      mode: "warn",
      logger,
      production: true,
      connect: async () => fakeSession({ ledger }).client,
    });
    expect(warned.errors[0]).toBe("Migration 0011 is pending");
  });

  it("leaves an empty database to the ordinary check", async () => {
    const { logger } = recordingLogger();
    const empty = () => fakeSession({ ledger: null, applicationTables: false }).client;
    await expect(
      assertSchemaCurrent({ mode: "enforce", logger, production: true, connect: async () => empty() }),
    ).rejects.toBeInstanceOf(SchemaNotCurrentError);
    const skipped = await assertSchemaCurrent({ mode: "off", logger, production: true, connect: async () => empty() });
    expect(skipped.skipped).toBe(true);
  });

  it("keeps each mode's behavior when the database cannot be reached", async () => {
    const unreachable = () => Promise.reject(new Error("connect ECONNREFUSED"));
    const { logger, calls } = recordingLogger();
    const off = await assertSchemaCurrent({ mode: "off", logger, production: true, connect: unreachable });
    expect(off).toEqual({ mode: "off", skipped: true, errors: [], warnings: [] });
    expect(calls[0]).toMatchObject({
      level: "warn",
      message:
        "Database adoption check did not complete (continuing because MIGRATIONS_CHECK=off): Schema check could not complete: connect ECONNREFUSED",
    });
    const warned = await assertSchemaCurrent({ mode: "warn", logger, production: true, connect: unreachable });
    expect(warned.errors).toEqual(["Schema check could not complete: connect ECONNREFUSED"]);
    await expect(
      assertSchemaCurrent({ mode: "enforce", logger, production: true, connect: unreachable }),
    ).rejects.toBeInstanceOf(SchemaNotCurrentError);
  });

  it("keeps today's behavior outside production", async () => {
    const { logger } = recordingLogger();
    const session = fakeSession({ ledger: null });
    const warned = await assertSchemaCurrent({ mode: "warn", logger, production: false, connect: async () => session.client });
    expect(warned.errors).toEqual([
      "Migration ledger is missing; run migrate adopt for an existing database or apply on an empty database",
    ]);
    expect(session.queries.some((query) => /table_name NOT IN/.test(query))).toBe(false);
    const connect = vi.fn();
    expect(await assertSchemaCurrent({ mode: "off", logger, production: false, connect })).toMatchObject({ skipped: true });
    expect(connect).not.toHaveBeenCalled();
  });
});
