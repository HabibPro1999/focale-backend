import { expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DbExecutor } from "../client";
import { networkingStore } from "./networking-store";

function reader() {
  const predicates: any[] = [];
  const selections: any[] = [];
  const chain = {
    from: vi.fn().mockReturnThis(), innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn((predicate) => { predicates.push(predicate); return chain; }),
    groupBy: vi.fn().mockReturnThis(),
    then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve([])),
  };
  const db = { select: vi.fn((columns) => { selections.push(columns); return chain; }) };
  return { store: networkingStore(db as unknown as DbExecutor), predicates, selections, chain };
}
const compiled = (predicate: any) => new PgDialect({ casing: "snake_case" }).sqlToQuery(predicate);

it("inserts availability in chunks of 500 without returning rows", async () => {
  const values = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn(() => ({ values }));
  const store = networkingStore({ insert } as unknown as DbExecutor);
  const slots = Array.from({ length: 1201 }, (_, i) => ({ eventId: "e", profileId: "p", startsAt: new Date(i * 300000) }));
  await store.insertAvailability(slots);
  expect(values.mock.calls.map(([rows]) => rows.length)).toEqual([500, 500, 201]);
  expect(values.mock.calls.flatMap(([rows]) => rows)).toEqual(slots);
  await store.insertAvailability([]);
  expect(insert).toHaveBeenCalledTimes(3);
});

it("scopes analytics by client and normalized email, then by own profile IDs without message bodies", async () => {
  const { store, predicates, selections } = reader();
  await store.personalAnalyticsProfiles("client", "own@example.test");
  expect(compiled(predicates[0]).sql).toContain('lower(trim("networking_profiles"."email"))');
  expect(compiled(predicates[0]).params).toEqual(["client", "own@example.test"]);
  await store.personalAnalyticsRows("event", ["own", "duplicate"]);
  for (const predicate of predicates.slice(1)) {
    expect(compiled(predicate).params).toContain("event");
    expect(compiled(predicate).params).toContain("own");
    expect(compiled(predicate).params).toContain("duplicate");
  }
  expect(selections[3]).toHaveProperty("senderId");
  expect(Object.keys(selections[3])).toEqual(["senderId"]);
  expect(selections.every(columns => columns !== undefined)).toBe(true);
});

it("bounds conflict queries by active status and half-open candidate windows and aggregates historical usage including completed", async () => {
  const { store, predicates, chain } = reader();
  const start = new Date("2099-01-01T09:00Z"), end = new Date("2099-01-01T09:30Z");
  await store.allocationMeetings("event", start, end);
  await store.allocationReservations("event", start, end, "profile:p");
  for (const predicate of predicates) {
    const query = compiled(predicate);
    expect(query.params).toEqual(expect.arrayContaining(["event", "PENDING", "CONFIRMED", "PENDING_ALLOCATION", start.toISOString(), end.toISOString()]));
    expect(query.sql).toContain('"starts_at" <');
    expect(query.params).not.toContain("COMPLETED");
  }
  expect(compiled(predicates[0]).sql).toContain('"ends_at" >');
  expect(compiled(predicates[1]).sql).toContain('"starts_at" >=');
  expect(compiled(predicates[1]).params).toContain("profile:p");
  await store.allocationTableUsage("event");
  expect(compiled(predicates[2]).params).toEqual(["event", "PENDING", "CONFIRMED", "PENDING_ALLOCATION", "COMPLETED"]);
  expect(chain.groupBy).toHaveBeenCalledOnce();
});
