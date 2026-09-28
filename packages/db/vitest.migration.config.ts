import { defineConfig } from "vitest/config";
import { dbTierConfig } from "../vitest.shared";

// Migration tier: applies packages/db/migrations/*.sql in order to a scratch
// database it creates + drops itself (direct pg, no drizzle-kit), then introspects.
export default defineConfig(
  dbTierConfig({
    include: ["tests/migration/**/*.migration.test.ts"],
    setupFiles: ["./tests/setup.migration.ts"],
    testTimeout: 120000,
    maxWorkersDefault: 1,
  }),
);
