import { expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DbExecutor } from "../client";
import { networkingStore } from "./networking-store";

function reader(results: unknown[][] = []) {
  const predicates: any[] = [];
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn(predicate => { predicates.push(predicate); return chain; }),
    orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(),
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(results.shift() ?? [])),
  };
  const select = vi.fn(() => chain);
  return { store: networkingStore({ select } as unknown as DbExecutor), chain, predicates, select };
}
const compile = (value: any) => new PgDialect({ casing: "snake_case" }).sqlToQuery(value);

it("selects only event-local start-day rows with half-open boundaries, deterministic order, filters and 5001 cap", async () => {
  const { store, chain, predicates } = reader();
  const start = new Date("2026-03-28T23:00Z"), end = new Date("2026-03-29T22:00Z");
  await store.calendarMeetings("event", start, end, { status: "CONFIRMED", tableId: "table" });
  const query = compile(predicates[0]);
  expect(query.params).toEqual(["event", start.toISOString(), end.toISOString(), "CONFIRMED", "table"]);
  expect(query.sql).toContain('"event_id" =');
  expect(query.sql).toContain('"starts_at" >=');
  expect(query.sql).toContain('"starts_at" <');
  expect(query.sql).not.toContain('"ends_at"'); // No overlap from yesterday: admin groups by start date.
  expect(query.sql).toContain('"status"::text =');
  expect(query.sql).toContain('"table_id" =');
  expect(chain.limit).toHaveBeenCalledWith(5001);
  expect(chain.orderBy.mock.calls[0].map(column => column.name)).toEqual(["startsAt", "id"]);
  await store.calendarMeetings("other-event", start, end, {});
  expect(compile(predicates[1]).params).toEqual(["other-event", start.toISOString(), end.toISOString()]);
});
it("batch loads only related event-scoped tables, participant/representative profiles and spaces", async () => {
  const { store, select, predicates } = reader([
    [{ id: "table", spaceId: "space", ownerProfileId: "legacy-owner" }], [], [],
  ]);
  await store.calendarRelations("event", [{ requesterId: "a", recipientId: "b", tableId: "table" }] as any);
  expect(select).toHaveBeenCalledTimes(3);
  const compiled = predicates.map(compile);
  expect(compiled[0].params).toEqual(["event", "table"]);
  expect(compiled[1].params).toEqual(["event", "a", "b", "legacy-owner", "table"]);
  expect(compiled[1].sql).toContain('"stand_table_id" in');
  expect(compiled[2].params).toEqual(["event", "space"]);
});
it("does not query relations for an empty day", async () => {
  const { store, select } = reader();
  expect(await store.calendarRelations("event", [])).toEqual({ profiles: [], tables: [], spaces: [] });
  expect(select).not.toHaveBeenCalled();
});
