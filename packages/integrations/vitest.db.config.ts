import { defineConfig } from "vitest/config";
import {
  dbTestMaxWorkers,
  dbTestSetupTimeoutMs,
  resolveConditions,
} from "../db/vitest.shared";

const maxWorkers = dbTestMaxWorkers();
export default defineConfig({
  ...resolveConditions,
  ssr: resolveConditions,
  test: {
    environment: "node",
    include: ["src/**/*.db.test.ts"],
    setupFiles: ["../../vitest.unit.setup.ts", "../db/tests/setup.db.ts"],
    globalSetup: ["../db/tests/global.db.setup.ts"],
    testTimeout: 30000,
    hookTimeout: dbTestSetupTimeoutMs(),
    pool: "forks",
    fileParallelism: maxWorkers > 1,
    maxWorkers,
    minWorkers: 1,
  },
});
