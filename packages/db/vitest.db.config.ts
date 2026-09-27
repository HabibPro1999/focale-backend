import { defineConfig } from "vitest/config";
import { dbTierConfig } from "../vitest.shared";

// General real-DB tier. Each test file gets its own disposable database; cap
// parallel migrations so the disposable service does not get overwhelmed.
export default defineConfig(
  dbTierConfig({
    include: ["tests/db/**/*.db.test.ts"],
    globalSetup: ["./tests/global.db.setup.ts"],
    setupFiles: ["./tests/setup.db.ts"],
    testTimeout: 30000,
  }),
);
