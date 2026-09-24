import { afterAll, beforeAll } from "vitest";
import { inject } from "vitest";
import { createTestDatabase } from "../src/testing";
import { dbTestsEnabled } from "./helpers/test-env";

// Point DATABASE_URL at the disposable test DB before any @app/db import touches
// the lazy pool. When ungated we do nothing here — the test files themselves skip
// via describe.runIf(dbTestsEnabled()), so no connection is ever opened.
const enabled = dbTestsEnabled();
const template = enabled ? inject<{ name: string; engine: "postgres" | "cockroach" }>("dbTestTemplate") : undefined;
let scratch: Awaited<ReturnType<typeof createTestDatabase>> | undefined;

if (enabled) {
  beforeAll(async () => {
    scratch = await createTestDatabase({
      label: `file_${process.env.VITEST_POOL_ID ?? "worker"}`,
      templateName: template?.engine === "postgres" ? template.name : undefined,
      engine: template?.engine,
    });
    process.env.DATABASE_URL = scratch.url;
    // The migration runner deliberately retains the engine's default isolation.
    // Application DB-tier sessions use the tested READ COMMITTED contract on
    // CockroachDB; PostgreSQL already defaults to READ COMMITTED.
    const { getDb } = await import("@app/db");
    if (scratch.engine === "cockroach") {
      const pool = (getDb() as unknown as {
        $client?: {
          options?: {
            onConnect?: (client: { query: (sql: string) => Promise<unknown> }) => Promise<void>;
          };
        };
      }).$client;
      if (!pool?.options) throw new Error("[test-db] Cannot configure Cockroach test sessions.");
      pool.options.onConnect = async (client) => {
        await client.query("SET default_transaction_isolation = 'read committed'");
      };
    }
  });
}

afterAll(async () => {
  if (!scratch) return;
  const { closeDb } = await import("@app/db");
  await closeDb();
  await scratch.close();
});
