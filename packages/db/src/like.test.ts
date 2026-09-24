import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { escapeLike, ilikeContains } from "./like";
import { registrations } from "./schema/registrations";
import { searchRegistrantsForSponsorship } from "./queries/sponsorships";

describe("escapeLike", () => {
  it("escapes the escape character, % and _", () => {
    expect(escapeLike("50%_off")).toBe("50\\%\\_off");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
    expect(escapeLike("\\%")).toBe("\\\\\\%");
  });

  it("leaves other characters untouched", () => {
    expect(escapeLike("jean-luc o'neil@x.tn [*]")).toBe("jean-luc o'neil@x.tn [*]");
    expect(escapeLike("")).toBe("");
  });
});

describe("ilikeContains", () => {
  it("binds the escaped term and declares an explicit backslash ESCAPE", () => {
    const query = new PgDialect({ casing: "snake_case" }).sqlToQuery(
      ilikeContains(registrations.email, "a_b%"),
    );
    expect(query.sql).toBe(`"registrations"."email" ILIKE $1 ESCAPE '\\'`);
    expect(query.params).toEqual(["%a\\_b\\%%"]);
  });
});

describe("searchRegistrantsForSponsorship SQL", () => {
  it("matches the term literally on email, first and last name", async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const client = {
      // node-postgres signature: query(config, values).
      query: async (config: { text: string }, values: unknown[]) => {
        calls.push({ text: config.text, values });
        return { rows: [], rowCount: 0, fields: [] };
      },
    };
    const db = drizzle(client as never, { casing: "snake_case" });

    await searchRegistrantsForSponsorship(
      "event-1",
      { query: "100%_\\", unpaidOnly: false, limit: 10 },
      db as never,
    );

    expect(calls).toHaveLength(1);
    const { text, values } = calls[0];
    expect(text.match(/ILIKE \$\d+ ESCAPE '\\'/g)).toHaveLength(3);
    expect(text).not.toMatch(/ilike \$\d+(?! ESCAPE)/i);
    const pattern = "%100\\%\\_\\\\%";
    expect(values.filter((v) => v === pattern)).toHaveLength(3);
  });
});
