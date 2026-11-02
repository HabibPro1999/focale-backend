import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";
import { swcDecoratorOptions, unitConfig } from "../../packages/vitest.shared";

export default defineConfig({
  ...unitConfig({
    include: ["src/**/*.test.ts"],
    setupFiles: ["../../vitest.unit.setup.ts"],
  }),
  plugins: [swc.vite(swcDecoratorOptions())],
});
