import { unitConfig } from "../db/vitest.shared";

export default unitConfig({
  include: ["src/**/*.test.ts"],
  setupFiles: ["../../vitest.unit.setup.ts"],
});
