import { defineConfig } from "vitest/config";

// Resolve @app/db to workspace source (mirrors vitest.config.ts).
const conditions = ["@app/source", "require", "node", "default"];

// General real-DB tier. fileParallelism off (mirrors legacy) so files sharing the
// disposable database run sequentially.
export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    environment: "node",
    include: ["tests/db/**/*.db.test.ts"],
    setupFiles: ["./tests/setup.db.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
    fileParallelism: false,
  },
});
