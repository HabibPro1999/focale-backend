import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/index.ts",
  // Unified migrations are ledgered; generated introspection belongs in scratch.
  out: "./.drizzle-scratch",
  casing: "snake_case",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
