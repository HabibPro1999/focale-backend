import { expect, it } from "vitest";
import { ExportRegistrationsBodySchema, ExportRegistrationsQuerySchema } from "./reports";
it("accepts the same role filter in standard and modular registration exports", () => {
  expect(ExportRegistrationsQuerySchema.parse({ role: "SPEAKER" })).toMatchObject({ role: "SPEAKER" });
  expect(ExportRegistrationsBodySchema.parse({ filters: { role: "SPEAKER" }, columns: { identity: ["email"] } })).toMatchObject({ filters: { role: "SPEAKER" } });
  expect(ExportRegistrationsQuerySchema.safeParse({ role: "OWNER" }).success).toBe(false);
});
