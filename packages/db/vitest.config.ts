import { defineConfig } from "vitest/config";
import { resolveConditions } from "./vitest.shared";

export default defineConfig({
  ...resolveConditions,
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
