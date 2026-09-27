import { unitConfig } from "./vitest.shared";

export default unitConfig({
  include: ["src/**/*.test.ts", "tests/helpers/**/*.test.ts"],
  setupFiles: ["../../vitest.unit.setup.ts"],
});
