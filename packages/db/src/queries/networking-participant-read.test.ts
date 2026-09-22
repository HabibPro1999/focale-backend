import { beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
const mock = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../client", () => ({ getDb: () => drizzle({ client: mock as unknown as Pool, casing: "snake_case" }) }));
import { countNetworkingConnectionSummaries, countNetworkingParticipantMeetings, listNetworkingConnectionSummaries, listNetworkingParticipantMeetings } from "./networking-participant-read";
beforeEach(() => { mock.query.mockReset().mockResolvedValue({ rows: [] }); });
const issued = () => mock.query.mock.calls.map(([q, params]) => ({ sql: q.text as string, params }));
const after = { at: new Date("2030-01-01T00:00:00.000Z"), id: "boundary" };

it("bounds connection SQL by limit+1 and descending composite key; counts identical visibility before cursor", async () => {
  await listNetworkingConnectionSummaries("event", "self", ["PAID"], { limit: 2, after });
  await countNetworkingConnectionSummaries("event", "self", ["PAID"]);
  const [page, count] = issued();
  expect(page.sql).toContain('("networking_connections"."created_at", "networking_connections"."id") <');
  expect(page.sql).toMatch(/order by "networking_connections"\."created_at" desc, "networking_connections"\."id" desc limit \$\d+$/);
  expect(page.params.at(-1)).toBe(3);
  expect(count.sql).not.toContain("limit");
  expect(count.params).not.toContain("boundary");
  for (const query of [page, count]) {
    expect(query.params).toEqual(expect.arrayContaining(["event", "self", "PAID", "ACTIVE", true]));
    for (const filter of ['"networking_connections"."event_id" =', '"networking_profiles"."event_id" =', '"registrations"."event_id" =', '"networking_profiles"."consent" =', '"networking_profiles"."withdrawn_at" IS NULL', '"registrations"."networking_opt_in" IS DISTINCT FROM false', 'lower("networking_profiles"."email")<>', 'NOT EXISTS (SELECT 1 FROM networking_blocks']) expect(query.sql).toContain(filter);
  }
  // The complete authorization predicate is shared, not a weaker count filter.
  const countWhere = count.sql.slice(count.sql.indexOf(" where "));
  expect(countWhere).not.toContain("boundary");
  expect(page.sql.replace(/\$\d+/g, "?")).toContain(countWhere.slice(7).replace(/\$\d+/g, "?"));
});

it("bounds meeting SQL by participant/event and ascending composite key with a pre-cursor count", async () => {
  await listNetworkingParticipantMeetings("event", "self", { limit: 200, after });
  await countNetworkingParticipantMeetings("event", "self");
  const [page, count] = issued();
  expect(page.sql).toContain('("networking_meetings"."starts_at", "networking_meetings"."id") >');
  expect(page.sql).toMatch(/order by "networking_meetings"\."starts_at", "networking_meetings"\."id" limit \$\d+$/);
  expect(page.params.at(-1)).toBe(201);
  expect(count.params).toEqual(["event", "self", "self"]);
  expect(count.sql).not.toContain("limit");
  for (const query of [page, count]) {
    expect(query.sql).toContain('"networking_meetings"."event_id" =');
    expect(query.sql).toContain('"networking_meetings"."requester_id" =');
    expect(query.sql).toContain('or "networking_meetings"."recipient_id" =');
  }
});

it("retains unbounded legacy SQL and activity-based connection ordering", async () => {
  await listNetworkingConnectionSummaries("event", "self", ["PAID"]);
  await listNetworkingParticipantMeetings("event", "self");
  const [connections, meetings] = issued();
  expect(connections.sql).toMatch(/order by coalesce\("latest_message"\."created_at","networking_connections"\."created_at"\) DESC, "networking_connections"\."id"$/);
  expect(meetings.sql).toMatch(/order by "networking_meetings"\."starts_at", "networking_meetings"\."id"$/);
});
