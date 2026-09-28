import { defineConfig } from "vitest/config";
import { unitConfig } from "../vitest.shared";

export default defineConfig(
  unitConfig({
    include: ["src/**/*.test.ts", "tests/helpers/**/*.test.ts"],
    setupFiles: ["../../vitest.unit.setup.ts"],
  }),
);
