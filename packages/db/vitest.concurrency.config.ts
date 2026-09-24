import { defineConfig } from "vitest/config";
import { dbTestMaxWorkers, dbTestSetupTimeoutMs, resolveConditions } from "./vitest.shared";

// Concurrency tier: each file gets a separate disposable DB, while race tests
// still use genuine parallel transactions within that database.
const maxWorkers = dbTestMaxWorkers();
export default defineConfig({
  ...resolveConditions,
  test: {
    environment: "node",
    include: ["tests/concurrency/**/*.concurrency.test.ts"],
    globalSetup: ["./tests/global.db.setup.ts"],
    setupFiles: ["./tests/setup.db.ts"],
    testTimeout: 60000,
    hookTimeout: dbTestSetupTimeoutMs(),
    pool: "forks",
    fileParallelism: maxWorkers > 1,
    maxWorkers,
    minWorkers: 1,
  },
});
