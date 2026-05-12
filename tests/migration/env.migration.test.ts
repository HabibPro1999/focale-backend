import { describe, expect, it } from "vitest";

describe("migration test tier environment", () => {
  it("uses an explicitly allowed disposable migration database URL", () => {
    expect(process.env.ALLOW_DB_TESTS).toBe("1");
    expect(process.env.TEST_MIGRATION_DATABASE_URL).toBeTruthy();
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_MIGRATION_DATABASE_URL);
  });
});
