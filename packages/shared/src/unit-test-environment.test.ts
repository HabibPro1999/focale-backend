import { expect, it } from "vitest";

it("uses the local dummy database URL for unit tests", () => {
  expect(process.env.DATABASE_URL).toBe(
    "postgresql://test_user:test_password@localhost:5432/focale_unit_test",
  );
});
