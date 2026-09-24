import { afterEach, describe, expect, it, vi } from "vitest";

// configureDb with the app's parsed slice: the pool uses it instead of
// process.env. (Separate file: the configured slice is process-wide.)
const fake = vi.hoisted(() => ({ configs: [] as Array<Record<string, unknown>> }));
vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  class FakePool extends EventEmitter {
    readonly end = vi.fn(async () => undefined);
    constructor(readonly config: Record<string, unknown>) {
      super();
      fake.configs.push(config);
    }
    async connect() {
      return { query: async () => ({ rows: [] }), release: vi.fn() };
    }
  }
  return { Pool: FakePool };
});

import { DB_SETTING_DEFAULTS } from "@app/contracts";
import { closeDb, configureDb, getDb, getDbSettings } from "./client";

afterEach(async () => {
  await closeDb();
});

describe("configureDb with a parsed config slice", () => {
  it("rejects half a slice", () => {
    expect(() =>
      configureDb({ applicationName: "focale-unit", databaseUrl: "postgresql://x@h/db" }),
    ).toThrow(/both databaseUrl and settings/);
  });

  it("builds the pool from the configured URL and settings, not process.env", () => {
    const settings = {
      poolMax: 7,
      statementTimeoutMs: 12_000,
      idleInTransactionTimeoutMs: DB_SETTING_DEFAULTS.idleInTransactionTimeoutMs,
      exportStatementTimeoutMs: DB_SETTING_DEFAULTS.exportStatementTimeoutMs,
    };
    process.env.DB_POOL_MAX = "1000"; // invalid, but ignored once configured
    try {
      configureDb({
        applicationName: "focale-unit",
        databaseUrl: "postgresql://u:p@db.internal:5432/focale_configured_test",
        settings,
      });
      getDb();
    } finally {
      delete process.env.DB_POOL_MAX;
    }

    expect(getDbSettings()).toBe(settings);
    expect(fake.configs.at(-1)).toMatchObject({
      connectionString: "postgresql://u:p@db.internal:5432/focale_configured_test",
      application_name: "focale-unit",
      max: 7,
    });
    // A pool already exists: the slice can no longer change.
    expect(() =>
      configureDb({ applicationName: "focale-unit", databaseUrl: "postgresql://x@h/db", settings }),
    ).toThrow(/before the database pool/);
  });
});
