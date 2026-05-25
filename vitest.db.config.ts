import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { testExclude } from "./vitest.base.config.js";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["tests/db/**/*.db.test.ts"],
      exclude: testExclude,
      setupFiles: ["./tests/setup.db.ts"],
      testTimeout: 30000,
      hookTimeout: 30000,
      pool: "forks",
      fileParallelism: false,
    },
  }),
);
