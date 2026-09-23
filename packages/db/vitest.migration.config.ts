import { defineConfig } from "vitest/config";
import { dbTestMaxWorkers, dbTestSetupTimeoutMs, resolveConditions } from "./vitest.shared";

// Migration tier: applies packages/db/migrations/*.sql in order to a scratch
// database it creates + drops itself (direct pg, no drizzle-kit), then introspects.
const maxWorkers = dbTestMaxWorkers(1);
export default defineConfig({
  ...resolveConditions,
  test: {
    environment: "node",
    include: ["tests/migration/**/*.migration.test.ts"],
    setupFiles: ["./tests/setup.migration.ts"],
    testTimeout: 120000,
    hookTimeout: dbTestSetupTimeoutMs(),
    pool: "forks",
    fileParallelism: maxWorkers > 1,
    maxWorkers,
    minWorkers: 1,
  },
});
