import swc from "unplugin-swc";
import { unitConfig, swcDecoratorOptions } from "../../packages/db/vitest.shared";

export default unitConfig({
  plugins: [swc.vite(swcDecoratorOptions())],
  include: ["src/**/*.test.ts"],
  setupFiles: ["../../vitest.unit.setup.ts"],
});
