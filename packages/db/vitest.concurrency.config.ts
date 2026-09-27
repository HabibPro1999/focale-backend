import { dbTierConfig } from "./vitest.shared";

export default dbTierConfig({
  include: ["tests/concurrency/**/*.concurrency.test.ts"],
  globalSetup: ["./tests/global.db.setup.ts"],
  setupFiles: ["./tests/setup.db.ts"],
  testTimeout: 60000,
});
