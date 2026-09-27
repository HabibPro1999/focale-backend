import { dbTierConfig } from "./vitest.shared";

export default dbTierConfig({
  include: ["tests/db/**/*.db.test.ts"],
  globalSetup: ["./tests/global.db.setup.ts"],
  setupFiles: ["./tests/setup.db.ts"],
  testTimeout: 30000,
});
