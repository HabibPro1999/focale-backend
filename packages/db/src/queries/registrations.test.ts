import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { buildRegistrationWhere, registrationSearchClause } from "./registrations";

const dialect = new PgDialect({ casing: "snake_case" });
const render = (sql: SQL) => dialect.sqlToQuery(sql);

const SEARCH_COLUMNS = ["email", "first_name", "last_name", "phone", "reference_number"];

describe("registration search", () => {
  it("requires each word of a full name to match some searchable column", () => {
    const { sql, params } = render(registrationSearchClause("  Mehdi   Trabelsi ")!);

    // one OR group per word, ANDed together
    expect(sql.split(" and ")).toHaveLength(2);
    for (const column of SEARCH_COLUMNS) {
      expect(sql).toContain(`"${column}" ilike`);
    }
    expect(params).toEqual([
      ...SEARCH_COLUMNS.map(() => "%Mehdi%"),
      ...SEARCH_COLUMNS.map(() => "%Trabelsi%"),
    ]);
  });

  it("matches LIKE metacharacters literally", () => {
    const { params } = render(registrationSearchClause("50%_off\\")!);
    expect(params[0]).toBe("%50\\%\\_off\\\\%");
  });

  it("adds no predicate for a blank search", () => {
    expect(registrationSearchClause("   ")).toBeUndefined();
    const { sql } = render(buildRegistrationWhere("event-1", { search: "   " })!);
    expect(sql).not.toContain("ilike");
  });

  it("scopes the search to the event", () => {
    const { sql, params } = render(
      buildRegistrationWhere("event-1", { search: "Mehdi" })!,
    );
    expect(sql).toContain('"event_id" = $1');
    expect(params[0]).toBe("event-1");
    expect(params.slice(1)).toEqual(SEARCH_COLUMNS.map(() => "%Mehdi%"));
  });
});
