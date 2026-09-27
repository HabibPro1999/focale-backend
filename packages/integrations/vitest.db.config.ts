import { dbTierConfig } from "../db/vitest.shared";

export default dbTierConfig({
  include: ["src/**/*.db.test.ts"],
  setupFiles: ["../../vitest.unit.setup.ts", "../db/tests/setup.db.ts"],
  globalSetup: ["../db/tests/global.db.setup.ts"],
  testTimeout: 30000,
});
