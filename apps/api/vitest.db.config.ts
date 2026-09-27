import swc from "unplugin-swc";
import { dbTierConfig, swcDecoratorOptions } from "../../packages/db/vitest.shared";

export default dbTierConfig({
  plugins: [swc.vite(swcDecoratorOptions())],
  include: ["src/**/*.db.test.ts"],
  setupFiles: ["./vitest.setup.ts", "../../packages/db/tests/setup.db.ts"],
  globalSetup: ["../../packages/db/tests/global.db.setup.ts"],
  testTimeout: 30000,
});
