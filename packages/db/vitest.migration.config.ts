import { dbTierConfig } from "./vitest.shared";

// Migration files provision their own scratch database; no globalSetup.
export default dbTierConfig({
  include: ["tests/migration/**/*.migration.test.ts"],
  setupFiles: ["./tests/setup.migration.ts"],
  testTimeout: 120000,
  maxWorkersDefault: 1,
});
