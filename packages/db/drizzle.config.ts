import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/index.ts",
  // Generated drafts must stay outside the unified migrator's ledgered directory.
  out: "./.drizzle-scratch",
  casing: "snake_case",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
