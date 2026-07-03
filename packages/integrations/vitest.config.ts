import { defineConfig } from "vitest/config";

// @app/source first (workspace source). require/node before import so CJS-only deps resolve to their CJS entry.
const conditions = ["@app/source", "require", "node", "default"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
