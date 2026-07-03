import { defineConfig } from "vitest/config";

// Resolve @app/db to workspace source (mirrors vitest.config.ts).
const conditions = ["@app/source", "require", "node", "default"];

// Concurrency tier: real DB, genuine parallel workers. Parallelism inside a test
// comes from Promise.all over the pooled pg connections; fileParallelism is off
// (mirrors legacy) so separate files never race on the shared database.
export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    environment: "node",
    include: ["tests/concurrency/**/*.concurrency.test.ts"],
    setupFiles: ["./tests/setup.db.ts"],
    testTimeout: 60000,
    hookTimeout: 30000,
    pool: "forks",
    fileParallelism: false,
  },
});
