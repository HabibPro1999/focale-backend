import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";
import { swcDecoratorOptions, unitConfig } from "../../packages/vitest.shared";

export default defineConfig({
  ...unitConfig({
    include: ["src/**/*.test.ts"],
    exclude: [
      "**/*.db.test.ts",
      "**/*.concurrency.test.ts",
      "**/*.perf.test.ts",
    ],
    setupFiles: ["./vitest.setup.ts"],
  }),
  plugins: [swc.vite(swcDecoratorOptions())],
});
