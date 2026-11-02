import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";
import {
  dbTierConfig,
  swcDecoratorOptions,
} from "../../packages/vitest.shared";

export default defineConfig({
  ...dbTierConfig({
    include: ["src/**/*.concurrency.test.ts"],
    setupFiles: ["./vitest.setup.ts", "../../packages/db/tests/setup.db.ts"],
    globalSetup: ["../../packages/db/tests/global.db.setup.ts"],
    testTimeout: 120000,
  }),
  plugins: [swc.vite(swcDecoratorOptions())],
});
