import { defineConfig } from "vitest/config";
import { dbTestMaxWorkers, dbTestSetupTimeoutMs, resolveConditions } from "./vitest.shared";

// General real-DB tier. Each test file gets its own disposable database; cap
// parallel migrations so the disposable service does not get overwhelmed.
const maxWorkers = dbTestMaxWorkers();
export default defineConfig({
  ...resolveConditions,
  test: {
    environment: "node",
    include: ["tests/db/**/*.db.test.ts"],
    globalSetup: ["./tests/global.db.setup.ts"],
    setupFiles: ["./tests/setup.db.ts"],
    testTimeout: 30000,
    hookTimeout: dbTestSetupTimeoutMs(),
    pool: "forks",
    fileParallelism: maxWorkers > 1,
    maxWorkers,
    minWorkers: 1,
  },
});
