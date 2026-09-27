import { unitConfig } from "../db/vitest.shared";

export default unitConfig({
  include: ["src/**/*.test.ts"],
  exclude: ["**/*.db.test.ts", "**/*.perf.test.ts"],
  setupFiles: ["../../vitest.unit.setup.ts"],
});
