import { describe, expect, it } from "vitest";

describe("concurrency test tier environment", () => {
  it("uses the guarded DB test environment", () => {
    expect(process.env.ALLOW_DB_TESTS).toBe("1");
    expect(process.env.TEST_DATABASE_URL).toBeTruthy();
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
  });
});
