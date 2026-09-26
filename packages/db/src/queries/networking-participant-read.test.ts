import { beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { networkingProfiles } from "../schema/networking";
const mock = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../client", () => ({ getDb: () => drizzle({ client: mock as unknown as Pool, casing: "snake_case" }) }));
import {
  countNetworkingConnectionSummaries,
  countNetworkingIncomingInterests,
  countNetworkingParticipantMeetings,
  listNetworkingConnectionSummaries,
  listNetworkingIncomingInterests,
  listNetworkingParticipantMeetings,
} from "./networking-participant-read";
beforeEach(() => { mock.query.mockReset().mockResolvedValue({ rows: [] }); });
const issued = () => mock.query.mock.calls.map(([q, params]) => ({ sql: q.text as string, params }));
const after = { at: new Date("2030-01-01T00:00:00.000Z"), id: "boundary" };

it("picks the connection page by keyset + limit+1 in a subquery before the latest-message lateral; counts identical visibility", async () => {
  await listNetworkingConnectionSummaries("event", "self", ["PAID"], { limit: 2, after });
  await countNetworkingConnectionSummaries("event", "self", ["PAID"]);
  const [page, count] = issued();
  const [outer, subquery] = page.sql.split(/"networking_connections"\."id" in \(/);
  expect(outer).toContain("left join lateral");
  // The only outer limit is the one-row latest-message lateral; paging happens in the subquery.
  expect(outer!.replace(/left join lateral \(.*?\) "latest_message"/s, "")).not.toContain("limit");
  expect(subquery).not.toContain("lateral");
  expect(subquery).toContain('("networking_connections"."created_at", "networking_connections"."id") <');
  expect(subquery).toMatch(/order by "networking_connections"\."created_at" desc, "networking_connections"\."id" desc limit \$\d+\)/);
  expect(page.sql).toMatch(/\) order by "networking_connections"\."created_at" desc, "networking_connections"\."id" desc$/);
  expect(page.params).toContain(3);
  expect(page.params).toContain("boundary");
  expect(count.sql).not.toContain("limit");
  expect(count.params).not.toContain("boundary");
  for (const query of [{ sql: subquery!, params: page.params }, count]) {
    expect(query.params).toEqual(expect.arrayContaining(["event", "self", "PAID"]));
    // The policy's peer-mode fragment (4.6): eligibility, distinct identity, no block either way.
    for (const filter of ['"networking_connections"."event_id" =', '"networking_profiles"."event_id" =', '"registrations"."event_id"="networking_profiles"."event_id"', `"networking_profiles"."status"='ACTIVE'`, '"networking_profiles"."consent" AND', '"networking_profiles"."withdrawn_at" IS NULL', '"networking_profiles"."erased_at" IS NULL', '"registrations"."networking_opt_in" IS DISTINCT FROM false', '"registrations"."payment_status"::text IN (', 'lower(btrim("networking_profiles"."email"))<>', 'NOT EXISTS (SELECT 1 FROM networking_blocks']) expect(query.sql).toContain(filter);
  }
  // The complete authorization predicate is shared, not a weaker count filter.
  const countWhere = count.sql.slice(count.sql.indexOf(" where "));
  expect(countWhere).not.toContain("boundary");
  expect(subquery!.replace(/\$\d+/g, "?")).toContain(countWhere.slice(7).replace(/\$\d+/g, "?"));
});

it("looks one connection up by id under the same visibility predicate (K2)", async () => {
  await listNetworkingConnectionSummaries("event", "self", ["PAID"], undefined, { connectionId: "connection-1" });
  const [lookup] = issued();
  expect(lookup.params).toEqual(expect.arrayContaining(["connection-1", "event", "self", "PAID"]));
  expect(lookup.sql).toContain('"networking_connections"."id" = $');
  for (const filter of ['"networking_profiles"."consent" AND', 'NOT EXISTS (SELECT 1 FROM networking_blocks', '"registrations"."networking_opt_in" IS DISTINCT FROM false']) expect(lookup.sql).toContain(filter);
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

it("keeps unbounded internal export listings with activity-based connection ordering", async () => {
  await listNetworkingConnectionSummaries("event", "self", ["PAID"]);
  await listNetworkingParticipantMeetings("event", "self");
  const [connections, meetings] = issued();
  expect(connections.sql).toMatch(/order by coalesce\("latest_message"\."created_at","networking_connections"\."created_at"\) DESC, "networking_connections"\."id"$/);
  expect(meetings.sql).toMatch(/order by "networking_meetings"\."starts_at", "networking_meetings"\."id"$/);
});

it("pages incoming likes off the 0034 index in a LIMITed candidate subquery, deciding senders in profile mode (4.9)", async () => {
  const scope = { eventId: "event", profileId: "self", statuses: ["PAID"], discoveryEnabled: true };
  await listNetworkingIncomingInterests(scope, { limit: 20, after });
  await countNetworkingIncomingInterests(scope);
  const [page, count] = issued();
  const start = page.sql.indexOf("from (select "), end = page.sql.indexOf(') "incoming_candidates"');
  const candidates = page.sql.slice(start, end + ') "incoming_candidates"'.length);
  const outer = page.sql.slice(0, start) + page.sql.slice(end);
  // Candidates: the likes alone, the index predicate as a literal, a descending keyset and limit+1.
  expect(candidates).toContain(`"networking_interests"."action"='LIKE'`);
  expect(candidates).toContain('"networking_interests"."target_id" =');
  // created_at is a naive UTC timestamp: the cursor instant is converted, the column stays bare.
  expect(candidates).toContain(`("networking_interests"."created_at", "networking_interests"."id") < (CAST($`);
  expect(candidates).toContain(`AS timestamptz) AT TIME ZONE 'UTC', $`);
  expect(candidates).toMatch(/order by "networking_interests"\."created_at" desc, "networking_interests"\."id" desc limit \$\d+\) "incoming_candidates"/);
  expect(candidates).not.toContain("networking_profiles");
  expect(page.params).toEqual(expect.arrayContaining(["2030-01-01T00:00:00.000Z", "boundary", 21]));
  expect(page.sql).toMatch(/order by "incoming_candidates"\."created_at" desc, "incoming_candidates"\."id" desc$/);
  // Profile mode (4.6 fragments) per candidate: eligible, distinct, unblocked, then discoverable or connected.
  for (const query of [{ sql: outer! }, count])
    for (const filter of [`"networking_profiles"."status"='ACTIVE'`, 'NOT EXISTS (SELECT 1 FROM networking_blocks', '"networking_profiles"."visible" AND', "EXISTS (SELECT 1 FROM networking_connections elig_pc"])
      expect(query.sql).toContain(filter);
  expect(count.sql).not.toContain("limit");
  expect(count.params).not.toContain("boundary");
  mock.query.mockClear();
  await countNetworkingIncomingInterests({ ...scope, discoveryEnabled: false });
  const [closed] = issued();
  expect(closed.sql).toContain("(false OR EXISTS (SELECT 1 FROM networking_connections elig_pc");
});

it("fetches another candidate batch only while hidden senders leave the page short", async () => {
  const scope = { eventId: "event", profileId: "self", statuses: ["PAID"], discoveryEnabled: true };
  // drizzle reads a select as arrays in field order: id, created_at, the sender's columns, visible.
  const senderColumns = Object.keys(getTableColumns(networkingProfiles));
  const candidate = (n: number, visible: boolean) => [
    `i${n}`, `2030-01-01 00:00:0${n}.000`, ...senderColumns.map((key) => (key === "id" ? `p${n}` : null)), visible,
  ];
  // limit 2 → 3 wanted: the first batch (full) has one hidden sender, the second ends the likes.
  mock.query.mockReset()
    .mockResolvedValueOnce({ rows: [candidate(9, true), candidate(8, false), candidate(7, true)] })
    .mockResolvedValueOnce({ rows: [candidate(6, true)] });
  const items = await listNetworkingIncomingInterests(scope, { limit: 2 });
  expect(items.map((item) => [item.id, item.profile.id])).toEqual([["i9", "p9"], ["i7", "p7"], ["i6", "p6"]]);
  expect(items[0]!.createdAt).toEqual(new Date("2030-01-01T00:00:09.000Z"));
  const [first, second] = issued();
  expect(first!.sql).not.toContain("AT TIME ZONE");
  // The next batch starts after the last candidate, visible or not.
  expect(second!.params).toEqual(expect.arrayContaining(["2030-01-01T00:00:07.000Z", "i7", 3]));
  // A page that fills stops there.
  mock.query.mockReset().mockResolvedValueOnce({ rows: [candidate(5, true), candidate(4, true), candidate(3, true)] });
  expect(await listNetworkingIncomingInterests(scope, { limit: 2 })).toHaveLength(3);
  expect(mock.query).toHaveBeenCalledTimes(1);
});
