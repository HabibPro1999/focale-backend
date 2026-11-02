import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

const database = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../client", () => ({
  getDb: () => drizzle({ client: database as unknown as Pool, casing: "snake_case" }),
}));
import {
  getEventAccessNames,
  getReportEventAndAccess,
  getSponsorshipsReportData,
} from "./reports";

beforeEach(() => database.query.mockReset().mockResolvedValue({ rows: [] }));
const issued = () =>
  database.query.mock.calls.map(([query, params]) => ({
    sql: query.text as string,
    params,
  }));
const projection = (query: { sql: string }) =>
  query.sql.slice(0, query.sql.indexOf(" from "));

describe("report header query boundaries", () => {
  it("keeps sponsorship event, pricing, two-field access, and keys reads in sequence", async () => {
    expect(await getSponsorshipsReportData("event-1")).toEqual({
      event: null,
      currency: "TND",
      accessItems: [],
      keys: [],
    });
    const queries = issued();
    expect(queries).toHaveLength(4);
    expect(queries.slice(0, 3).map(projection)).toEqual([
      'select "slug", "name"',
      'select "currency"',
      'select "id", "name"',
    ]);
    expect(queries[0]!.params).toEqual(["event-1", 1]);
    expect(queries[1]!.params).toEqual(["event-1", 1]);
    expect(queries[2]!.params).toEqual(["event-1"]);
    expect(queries[2]!.sql).toContain('order by "event_access"."sort_order" asc');
    expect(queries[3]!.sql).toContain(
      'order by "sponsorships"."created_at" desc, "sponsorships"."id" desc',
    );
  });

  it("retains the different public access projections and event-first report header", async () => {
    await getEventAccessNames("event-1");
    await getReportEventAndAccess("event-1");
    expect(issued().map(projection)).toEqual([
      'select "id", "name"',
      'select "slug", "name"',
      'select "id", "name", "type"',
    ]);
  });
});
