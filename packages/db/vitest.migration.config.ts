import { defineConfig } from "vitest/config";
import { resolveConditions } from "./vitest.shared";

// Migration tier: applies packages/db/migrations/*.sql in order to a scratch
// database it creates + drops itself (direct pg, no drizzle-kit), then introspects.
export default defineConfig({
  ...resolveConditions,
  test: {
    environment: "node",
    include: ["tests/migration/**/*.migration.test.ts"],
    setupFiles: ["./tests/setup.migration.ts"],
    testTimeout: 120000,
    hookTimeout: 30000,
    pool: "forks",
    fileParallelism: false,
  },
});
