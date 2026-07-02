import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";

// @app/source first (workspace source). require/node before import so CJS-only
// deps like pg resolve to their CJS entry, not an ESM shim.
const conditions = ["@app/source", "require", "node", "default"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  plugins: [
    // SWC so decorator metadata (design:paramtypes) exists in tests — mirrors dev/build.
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
    include: ["src/**/*.test.ts"],
  },
});
