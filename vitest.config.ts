import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { testExclude } from "./vitest.base.config.js";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
      exclude: [
        ...testExclude,
        "tests/db/**",
        "tests/concurrency/**",
        "tests/migration/**",
      ],
      setupFiles: ["./tests/setup.ts"],
      testTimeout: 10000,
      hookTimeout: 10000,
      pool: "forks",
      fileParallelism: true,
    },
  }),
);
