import { defineConfig } from "vitest/config";
import { dbTierConfig } from "../vitest.shared";

// Concurrency tier: each file gets a separate disposable DB, while race tests
// still use genuine parallel transactions within that database.
export default defineConfig(
  dbTierConfig({
    include: ["tests/concurrency/**/*.concurrency.test.ts"],
    globalSetup: ["./tests/global.db.setup.ts"],
    setupFiles: ["./tests/setup.db.ts"],
    testTimeout: 60000,
  }),
);
