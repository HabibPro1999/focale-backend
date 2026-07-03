import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";

// @app/source first (workspace source). require/node before import so CJS-only deps resolve to their CJS entry.
const conditions = ["@app/source", "require", "node", "default"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
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
    include: ["src/**/*.test.ts"],
  },
});
