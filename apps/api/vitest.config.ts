import swc from "unplugin-swc";
import { unitConfig, swcDecoratorOptions } from "../../packages/db/vitest.shared";

export default unitConfig({
  plugins: [swc.vite(swcDecoratorOptions())],
  include: ["src/**/*.test.ts"],
  exclude: ["**/*.db.test.ts", "**/*.concurrency.test.ts", "**/*.perf.test.ts"],
  setupFiles: ["./vitest.setup.ts"],
});
