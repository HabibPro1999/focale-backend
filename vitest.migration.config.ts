import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { testExclude } from "./vitest.base.config.js";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["tests/migration/**/*.migration.test.ts"],
      exclude: testExclude,
      setupFiles: ["./tests/setup.migration.ts"],
      testTimeout: 120000,
      hookTimeout: 30000,
      pool: "forks",
      fileParallelism: false,
    },
  }),
);
