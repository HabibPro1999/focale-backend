import { defineConfig } from "vitest/config";
import base from "./vitest.config";

// Opt-in load runs (*.perf.test.ts), excluded from `pnpm test`; each file is
// gated by its own env flag (e.g. EXPORT_PERFORMANCE=1). One fork at a time so
// memory and event-loop measurements are not shared with other files.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["src/**/*.perf.test.ts"],
    exclude: ["**/node_modules/**"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 300_000,
  },
});
