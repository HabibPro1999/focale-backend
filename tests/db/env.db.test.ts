import { describe, expect, it } from "vitest";

describe("DB test tier environment", () => {
  it("uses an explicitly allowed disposable database URL", () => {
    expect(process.env.ALLOW_DB_TESTS).toBe("1");
    expect(process.env.TEST_DATABASE_URL).toBeTruthy();
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
  });
});
