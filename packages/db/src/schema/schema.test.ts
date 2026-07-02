import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { emailLogs } from "./email";
import { eventAccess } from "./events-access";
import { registrations } from "./registrations";
import { accessPrerequisites } from "./events-access";

// Cheap regression net: assert the load-bearing column-name mappings survive.
const colNames = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table).columns.map((c) => c.name);

describe("schema column mappings", () => {
  it("email_logs keeps the legacy sendgrid_message_id column name", () => {
    const cfg = getTableConfig(emailLogs);
    expect(cfg.name).toBe("email_logs");
    expect(colNames(emailLogs)).toContain("sendgrid_message_id");
    expect(colNames(emailLogs)).not.toContain("provider_message_id");
  });

  it("registrations maps role -> registration_role and has the id-array columns", () => {
    const names = colNames(registrations);
    expect(names).toContain("registration_role");
    expect(names).toContain("access_type_ids");
    expect(names).toContain("dropped_access_ids");
  });

  it("event_access.companion_price is bigint mode:number (prod column is INT8)", () => {
    // getTableConfig reports the property key for casing-derived columns
    // (snake_case is applied later by the client's casing config), so look up
    // by the camelCase key rather than the SQL column name.
    const col = getTableConfig(eventAccess).columns.find(
      (c) => c.name === "companionPrice",
    );
    expect(col?.getSQLType()).toBe("bigint");
  });

  it("_AccessPrerequisites keeps exact table + A/B column names", () => {
    const cfg = getTableConfig(accessPrerequisites);
    expect(cfg.name).toBe("_AccessPrerequisites");
    expect(colNames(accessPrerequisites).sort()).toEqual(["A", "B"]);
  });
});
