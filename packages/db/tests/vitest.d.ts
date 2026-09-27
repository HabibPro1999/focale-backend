import "vitest";

declare module "vitest" {
  interface ProvidedContext {
    dbTestTemplate:
      | { engine: "postgres"; name: string }
      | { engine: "cockroach"; name?: string };
  }
}
