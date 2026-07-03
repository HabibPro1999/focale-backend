import { afterAll } from "vitest";
import { dbTestsEnabled, loadDbEnv } from "./helpers/test-env";

// Point DATABASE_URL at the disposable test DB before any @app/db import touches
// the lazy pool. When ungated we do nothing here — the test files themselves skip
// via describe.runIf(dbTestsEnabled()), so no connection is ever opened.
if (dbTestsEnabled()) {
  loadDbEnv();
}

afterAll(async () => {
  if (!dbTestsEnabled()) return;
  const { getDb } = await import("@app/db");
  const client = (getDb() as unknown as { $client?: { end?: () => Promise<void> } })
    .$client;
  await client?.end?.();
});
