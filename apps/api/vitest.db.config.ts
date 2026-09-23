import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";
import {
  dbTestMaxWorkers,
  dbTestSetupTimeoutMs,
  resolveConditions,
} from "../../packages/db/vitest.shared";

const maxWorkers = dbTestMaxWorkers();
export default defineConfig({
  ...resolveConditions,
  ssr: resolveConditions,
  plugins: [
    swc.vite({
      module: { type: "es6" },
      jsc: {
        target: "es2022",
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    environment: "node",
    include: ["src/**/*.db.test.ts"],
    setupFiles: ["./vitest.setup.ts", "../../packages/db/tests/setup.db.ts"],
    globalSetup: ["../../packages/db/tests/global.db.setup.ts"],
    testTimeout: 30000,
    hookTimeout: dbTestSetupTimeoutMs(),
    pool: "forks",
    fileParallelism: maxWorkers > 1,
    maxWorkers,
    minWorkers: 1,
  },
});
