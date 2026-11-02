import "vitest";

declare module "vitest" {
  interface ProvidedContext {
    // PostgreSQL clones the global template; CockroachDB migrates per file.
    dbTestTemplate: { engine: "postgres"; name: string } | { engine: "cockroach" };
  }
}
