import {
  createScratchDatabase,
  dbTestsEnabled,
  janitorScratchDatabases,
  testDatabaseEngine,
} from "@app/db/testing";

export default async function globalDbSetup({
  provide,
}: {
  provide: (key: string, value: unknown) => void;
}) {
  if (!dbTestsEnabled()) return;
  await janitorScratchDatabases();
  const engine = await testDatabaseEngine();
  if (engine === "cockroach") {
    // CockroachDB 26.2.5 does not support CREATE DATABASE ... TEMPLATE. Each
    // setup.db file therefore creates and migrates its own isolated database.
    provide("dbTestTemplate", { engine });
    return;
  }
  const template = await createScratchDatabase({ label: "run_template" });
  await template.disconnect();
  provide("dbTestTemplate", { name: template.name, engine: template.engine });
  return async () => template.close();
}
