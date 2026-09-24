import { describe, expect, it, vi } from "vitest";
import {
  assertSchemaCurrent,
  SchemaNotCurrentError,
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
      if (/information_schema\.tables/i.test(text)) return { rows: [{ present: options.ledger !== null }] };
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
