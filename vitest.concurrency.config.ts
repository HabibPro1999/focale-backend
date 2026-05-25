import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { testExclude } from "./vitest.base.config.js";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["tests/concurrency/**/*.concurrency.test.ts"],
      exclude: testExclude,
      setupFiles: ["./tests/setup.db.ts"],
      testTimeout: 60000,
      hookTimeout: 30000,
      pool: "forks",
      fileParallelism: false,
    },
  }),
);
