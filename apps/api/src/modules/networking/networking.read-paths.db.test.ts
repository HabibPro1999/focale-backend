import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NetworkingConfigSchema } from "@app/contracts";
import {
  clients,
  forms,
  getDb,
  networkingIncomingCandidatesQuery,
  networkingStore,
  type NetworkingRow,
} from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { insertMatrixParticipant } from "./__testing__/eligibility-matrix-db";
import { streamText } from "./__testing__/stream-text";
import { NetworkingAdminService } from "./networking.admin.service";
import { NetworkingExportsService } from "./networking.exports.service";
import { NetworkingMeetingsService } from "./networking.meetings.service";
import { NetworkingSocialService } from "./networking.social.service";
import { NetworkingService, type NetworkingContext } from "./networking.service";

/**
 * Plan 4.9 read paths in a real database (both engines in CI): the agenda
 * hydrates a page in a fixed number of statements, incoming interests page by
 * keyset, organizer lists are SQL pages, and exports stream from SQL pages.
 * Statement counts are pinned: they must not grow with the rows.
 */
const N = 40;
const ids = { client: randomUUID(), event: randomUUID(), other: randomUUID(), access: randomUUID() };
// UTC+05:45: an organizer's day is not a UTC day.
const config = NetworkingConfigSchema.parse({
  enabled: true, timezone: "Asia/Kathmandu", eligiblePaymentStatuses: ["PAID"], swipeEnabled: true, meetingsEnabled: true,
});
const service = new NetworkingService();
const meetings = new NetworkingMeetingsService(service);
const social = new NetworkingSocialService(service);
const admin = new NetworkingAdminService(service, meetings);
const exportsService = new NetworkingExportsService(social, meetings);
const firstStart = Date.parse("2031-05-05T02:00:00Z");
const likedAt = new Date("2031-04-01T10:00:00.000Z");

let event: NetworkingRow<"events">;
let viewer: NetworkingRow<"profiles">;
const others: NetworkingRow<"profiles">[] = [];
let hidden: NetworkingRow<"profiles">;
let blocked: NetworkingRow<"profiles">;
let erased: NetworkingRow<"profiles">;
let ctx: NetworkingContext;
let table: NetworkingRow<"tables">;
let space: NetworkingRow<"spaces">;

/**
 * Every SQL statement sent while `run` runs, transactions included (pg
 * Client.query), except the session setup the CockroachDB test harness runs
 * on each new pool connection (packages/db/tests/setup.db.ts).
 */
async function statements<T>(run: () => Promise<T>) {
  const Client = (getDb().$client as unknown as { Client: { prototype: { query: (...args: unknown[]) => unknown } } }).Client;
  const spy = vi.spyOn(Client.prototype, "query");
  const harness = (text: unknown) => typeof text === "string" && text.startsWith("SET default_transaction_isolation");
  try {
    const result = await run();
    return { result, count: spy.mock.calls.filter(([text]) => !harness(text)).length };
  } finally {
    spy.mockRestore();
  }
}

describe.runIf(dbTestsEnabled())("networking read paths (4.9)", () => {
  beforeAll(async () => {
    const db = getDb();
    const store = networkingStore(getDb());
    await db.insert(clients).values({ id: ids.client, name: `Read paths ${ids.event}`, enabledModules: ["networking", "registrations", "emails"] });
    event = await store.insert("events", {
      id: ids.event, clientId: ids.client, name: "Read paths", slug: `read-paths-${ids.event}`, status: "OPEN",
      startDate: new Date("2031-05-04T00:00:00Z"), endDate: new Date("2031-05-08T00:00:00Z"),
    });
    await store.insert("configs", { eventId: ids.event, config });
    const formId = randomUUID();
    await db.insert(forms).values({ id: formId, eventId: ids.event, name: "Registration", schema: { steps: [] } });
    const scope = { clientId: ids.client, otherEventId: ids.other, accessId: ids.access };
    let created = Date.parse("2031-01-01T00:00:00Z");
    const participant = async (firstName: string, profile: Partial<NetworkingRow<"profiles">> = {}) => {
      const id = randomUUID();
      // Distinct creation times: the organizer list is oldest first.
      profile = { createdAt: new Date((created += 1000)), ...profile };
      return (await insertMatrixParticipant(scope, {
        eventId: ids.event, formId, id, email: `${id}@example.invalid`,
        registration: { eventId: ids.event, paymentStatus: "PAID", networkingOptIn: true },
        profile: { status: "ACTIVE", consent: true, visible: true, firstName, ...profile },
      })).profile;
    };
    viewer = await participant("Viewer", { featured: true, company: "Host" });
    ctx = { event, config, profile: viewer, session: {} as NetworkingRow<"sessions"> };
    space = await store.insert("spaces", { eventId: ids.event, name: "Hall" });
    table = await store.insert("tables", { eventId: ids.event, spaceId: space.id, name: "T1" });
    const names = [
      ["Émile", "Société Générale"], // precomposed accents
      ["José", "Decomposed"], // a combining accent
      ["مُحَمَّد", "Arabic"], // Arabic diacritics
    ];
    for (let index = 0; index < N; index++) {
      const [firstName, company] = names[index] ?? [`Other${index}`, `Company${index}`];
      const other = await participant(firstName!, {
        company: company!, sector: index % 2 ? "Health" : "Energy",
        lastActiveAt: index === 0 ? new Date() : null,
      });
      others.push(other);
      const startsAt = new Date(firstStart + index * 1_800_000);
      await store.insert("meetings", {
        eventId: ids.event, requesterId: viewer.id, recipientId: other.id, status: index === 3 ? "CANCELLED" : "CONFIRMED",
        startsAt, endsAt: new Date(+startsAt + 1_800_000), expiresAt: startsAt, tableId: index % 2 ? table.id : null,
      });
      // Every fifth like shares one timestamp: the keyset must still page them exactly once.
      await store.insert("interests", {
        eventId: ids.event, profileId: other.id, targetId: viewer.id, action: "LIKE",
        createdAt: index % 5 === 0 ? likedAt : new Date(+likedAt + index * 1000),
      });
    }
    const [first, second] = others as [NetworkingRow<"profiles">, NetworkingRow<"profiles">];
    const [a, b] = viewer.id < first.id ? [viewer.id, first.id] : [first.id, viewer.id];
    const connection = await store.insert("connections", { eventId: ids.event, profileAId: a, profileBId: b });
    const message = await store.insert("messages", { eventId: ids.event, connectionId: connection.id, senderId: first.id, body: "Rude", clientMessageId: randomUUID() });
    for (let index = 0; index < 12; index++)
      await store.insert("reports", {
        eventId: ids.event, reporterId: (index % 2 ? first : second).id, profileId: viewer.id, reason: `Report ${index}`,
        messageId: index === 0 ? message.id : null, status: index % 3 ? "OPEN" : "RESOLVED",
        createdAt: new Date(Date.parse("2031-04-02T10:00:00Z") + index * 60_000),
      });
    // Senders the exhibitor may not see: hidden and not connected; blocked by the exhibitor.
    hidden = await participant("Hidden", { visible: false });
    blocked = await participant("Blocked");
    await store.insert("blocks", { eventId: ids.event, profileId: viewer.id, targetId: blocked.id });
    for (const sender of [hidden, blocked])
      await store.insert("interests", { eventId: ids.event, profileId: sender.id, targetId: viewer.id, action: "LIKE", createdAt: new Date(+likedAt + 3_600_000) });
    // An erased tombstone: left out of the participant list and export, named by id elsewhere.
    erased = await participant("", { erasedAt: new Date(), withdrawnAt: new Date(), status: "EXCLUDED", consent: false });
    await store.insert("meetings", {
      eventId: ids.event, requesterId: erased.id, recipientId: others[5]!.id, status: "CANCELLED",
      startsAt: new Date(firstStart), endsAt: new Date(firstStart + 1_800_000), expiresAt: new Date(firstStart),
    });
  }, 120_000);
  afterEach(() => vi.restoreAllMocks());

  it("agenda: a page is hydrated in two statements, whatever its size (hydrateForViewer)", async () => {
    const counts: number[] = [];
    for (const limit of [5, 20, 200]) {
      const { result, count } = await statements(() => meetings.list(ctx, { limit }));
      expect(result.items).toHaveLength(Math.min(limit, N));
      counts.push(count);
    }
    // expire (2) + page + total + counterparts + places.
    expect(counts).toEqual([6, 6, 6]);
    const first = await meetings.list(ctx, { limit: 5 });
    const next = await statements(() => meetings.list(ctx, { limit: 5, cursor: first.nextCursor! }));
    // page + counterparts + places: no expiry or total after the first page.
    expect(next.count).toBe(3);
    const all = await statements(() => meetings.allMeetings(ctx));
    expect(all.result).toHaveLength(N);
    expect(all.count).toBe(5);
    // The same hydrated shape as before: public profiles, the table with its space.
    const [item] = first.items;
    expect(item!.requester).toMatchObject({ id: viewer.id, firstName: "Viewer" });
    expect(item!.requester).not.toHaveProperty("email");
    expect(item!.recipient).toMatchObject({ id: others[0]!.id });
    const withTable = first.items.find((row) => row.tableId)!;
    expect(withTable.table).toMatchObject({ id: table.id, name: "T1", space: { id: space.id, name: "Hall" } });
    expect(first.items.find((row) => !row.tableId)!.table).toBeNull();
  });

  it("agenda: a counterpart the viewer may not see is null, and a viewer who lost eligibility is refused", async () => {
    const store = networkingStore(getDb());
    const target = others[0]!;
    await store.update("profiles", { eventId: ids.event, id: target.id }, { visible: false });
    try {
      // Connected: still shown (profile mode).
      expect((await meetings.list(ctx, { limit: 1 })).items[0]!.recipient).toMatchObject({ id: target.id });
      const unconnected = others[1]!;
      await store.update("profiles", { eventId: ids.event, id: unconnected.id }, { visible: false });
      try {
        expect((await meetings.list(ctx, { limit: 2 })).items[1]!.recipient).toBeNull();
      } finally {
        await store.update("profiles", { eventId: ids.event, id: unconnected.id }, { visible: true });
      }
    } finally {
      await store.update("profiles", { eventId: ids.event, id: target.id }, { visible: true });
    }
    await store.update("profiles", { eventId: ids.event, id: viewer.id }, { status: "SUSPENDED" });
    try {
      await expect(meetings.list(ctx, { limit: 5 })).rejects.toMatchObject({ status: 403, response: { code: "NETWORKING_NOT_ELIGIBLE" } });
    } finally {
      await store.update("profiles", { eventId: ids.event, id: viewer.id }, { status: "ACTIVE" });
    }
  });

  it("incoming interests: keyset pages newest first, ties included once, senders filtered in SQL", async () => {
    const expected = [...others]
      .map((profile, index) => ({ id: profile.id, at: index % 5 === 0 ? +likedAt : +likedAt + index * 1000 }))
      .sort((x, y) => y.at - x.at || 0);
    const rows = await networkingStore(getDb()).all("interests", { eventId: ids.event, targetId: viewer.id });
    const interestOf = new Map(rows.map((row) => [row.profileId, row.id]));
    // created_at DESC, then interest id DESC.
    const order = expected
      .map((row) => ({ ...row, interest: interestOf.get(row.id)! }))
      .sort((x, y) => y.at - x.at || (y.interest < x.interest ? -1 : y.interest > x.interest ? 1 : 0))
      .map((row) => row.id);
    const seen: string[] = [];
    const counts: number[] = [];
    let cursor: string | undefined;
    let first = true;
    do {
      const { result, count } = await statements(() => social.incoming(ctx, { limit: 7, cursor }));
      if (first) expect(result.total).toBe(N);
      else expect(result).not.toHaveProperty("total");
      first = false;
      counts.push(count);
      seen.push(...result.items.map((item) => item.profile.id));
      for (const item of result.items) expect(item.profile).not.toHaveProperty("email");
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(order);
    expect(seen).not.toContain(hidden.id);
    expect(seen).not.toContain(blocked.id);
    // The two newest likes are the hidden and blocked senders': the first batch
    // comes up short, so the first page reads one more batch, then the total.
    // Every later page is one statement.
    expect(counts[0]).toBe(3);
    expect(new Set(counts.slice(1))).toEqual(new Set([1]));
  });

  it("organizer participant list: one SQL page with its total and counts, filters in SQL", async () => {
    const { result, count } = await statements(() => admin.profiles(ids.event, { page: 1, limit: 10 }));
    expect(count).toBe(3);
    // Listed: the viewer, the others, hidden and blocked; never the erased tombstone.
    expect(result.total).toBe(N + 3);
    expect(result.items).toHaveLength(10);
    expect(result.items[0]).toMatchObject({ id: viewer.id, matchCount: 1, meetingCount: N - 1 });
    expect(result.items[1]).toMatchObject({ id: others[0]!.id, matchCount: 1, meetingCount: 1 });
    const pages = [];
    for (let page = 1; page <= 5; page++) pages.push(...(await admin.profiles(ids.event, { page, limit: 10 })).items.map((row) => row.id));
    expect(new Set(pages).size).toBe(N + 3);
    expect(pages).not.toContain(erased.id);
    const total = async (query: Record<string, string>) => (await admin.profiles(ids.event, { page: 1, limit: 100, ...query })).total;
    expect(await total({ q: "société" })).toBe(1);
    expect(await total({ q: "company1" })).toBe(10); // Company10..19
    expect(await total({ sector: "Health" })).toBe(N / 2);
    expect(await total({ status: "ACTIVE" })).toBe(N + 3);
    expect(await total({ activity: "MATCHED" })).toBe(2);
    // Every other's meeting is on hold except the cancelled one (others[3]).
    expect(await total({ activity: "MEETINGS" })).toBe(N);
    expect(await total({ activity: "VERY_ACTIVE" })).toBe(1);
    expect(await total({ activity: "ACTIVE" })).toBe(0);
    expect(await total({ activity: "INACTIVE" })).toBe(N + 2);
  });

  it("organizer meeting list: one SQL page, folded search, the event-timezone day, hydrated in bulk", async () => {
    const { result, count } = await statements(() => admin.listMeetings(ids.event, { page: 2, limit: 10 }));
    // expire (2) + page + total + profiles + places.
    expect(count).toBe(6);
    expect(result.total).toBe(N + 1);
    expect(result.items).toHaveLength(10);
    const starts = result.items.map((row) => +row.startsAt);
    expect(starts).toEqual([...starts].sort((x, y) => x - y));
    expect(result.items.find((row) => row.tableId)!.table).toMatchObject({ name: "T1", space: { name: "Hall" } });
    expect(result.items[0]!.requester).toMatchObject({ id: viewer.id, email: viewer.email });
    const found = async (q: string) => (await admin.listMeetings(ids.event, { q, page: 1, limit: 100 })).items.map((row) => row.recipientId);
    expect(await found("emile test societe")).toEqual([others[0]!.id]);
    expect(await found("  EMILE ")).toEqual([others[0]!.id]);
    expect(await found("josé")).toEqual([others[1]!.id]);
    expect(await found("محمد")).toEqual([others[2]!.id]);
    expect(await found("viewer test")).toHaveLength(N);
    expect(await found("nobody")).toEqual([]);
    // 2031-05-05 in Kathmandu is [2031-05-04T18:15Z, 2031-05-05T18:15Z): starts from 02:00Z every 30 minutes.
    const day = await admin.listMeetings(ids.event, { date: "2031-05-05", page: 1, limit: 100 });
    const inDay = (start: number) => start >= Date.parse("2031-05-04T18:15:00Z") && start < Date.parse("2031-05-05T18:15:00Z");
    expect(day.total).toBe(others.filter((_, index) => inDay(firstStart + index * 1_800_000)).length + 1);
    expect((await admin.listMeetings(ids.event, { status: "CANCELLED", page: 1, limit: 100 })).total).toBe(2);
    expect((await admin.listMeetings(ids.event, { tableId: table.id, page: 1, limit: 100 })).total).toBe(N / 2);
    // No limit: every meeting (internal callers).
    expect((await admin.listMeetings(ids.event, {})).items).toHaveLength(N + 1);
  });

  it("organizer reports: newest first with their people and message, in two statements", async () => {
    const { result, count } = await statements(() => admin.reports(ids.event, { page: 1, limit: 5 }));
    expect(count).toBe(2);
    expect(result.total).toBe(12);
    expect(result.items.map((row) => row.reason)).toEqual(["Report 11", "Report 10", "Report 9", "Report 8", "Report 7"]);
    expect(result.items[0]).toMatchObject({ reporter: { id: others[0]!.id }, profile: { id: viewer.id }, message: null });
    const last = await admin.reports(ids.event, { page: 3, limit: 5 });
    expect(last.items.map((row) => row.reason)).toEqual(["Report 1", "Report 0"]);
    expect(last.items[1]).toMatchObject({ reporter: { id: others[1]!.id }, message: { body: "Rude" } });
    expect((await admin.reports(ids.event, { status: "RESOLVED", page: 1, limit: 50 })).total).toBe(4);
  });

  it("organizer exports stream every row from SQL pages; statements do not grow with the rows", async () => {
    const participants = await statements(async () => streamText((await exportsService.admin(event, "participants", "csv")).body));
    const lines = participants.result.trim().split("\r\n");
    expect(lines).toHaveLength(1 + N + 3);
    expect(participants.result).not.toContain(erased.id);
    // Viewer: no swipes, one match, no messages, N - 1 booked meetings (one was cancelled).
    expect(lines.find((line) => line.startsWith('"Viewer Test"'))!.endsWith(`"0","1","0","${N - 1}"`)).toBe(true);
    // ids (one short transaction) + one page of rows with their engagement (another).
    expect(participants.count).toBeLessThanOrEqual(10);
    const meetingsCsv = await streamText((await exportsService.admin(event, "meetings", "csv")).body);
    // The erased requester is named by id.
    expect(meetingsCsv).toContain(`"${erased.id}"`);
    expect(meetingsCsv.trim().split("\r\n")).toHaveLength(1 + N + 1);
  });

  it("EXPLAIN (PostgreSQL): an incoming batch reads the 0034 index backwards, without a sort", async (context) => {
    const pool = getDb().$client;
    const { rows: [engine] } = await pool.query<{ version: string }>("SELECT version() AS version");
    if (/cockroach/i.test(engine!.version)) return context.skip();
    const query = networkingIncomingCandidatesQuery(
      { eventId: ids.event, profileId: viewer.id, statuses: config.eligiblePaymentStatuses, discoveryEnabled: true },
      { at: new Date(+likedAt + 30_000), id: "ffffffff-ffff-4fff-bfff-ffffffffffff" },
      21,
    ).toSQL();
    // The fixture is small, so the planner may prefer a sequential scan; forbid it
    // to see the plan the index offers at scale.
    const client = await pool.connect();
    let plan: string;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
      const { rows: [row] } = await client.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (FORMAT JSON) ${query.sql}`, query.params);
      plan = JSON.stringify(row!["QUERY PLAN"]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(plan).toContain('"Index Name":"networking_interests_incoming_idx"');
    expect(plan).toContain('"Scan Direction":"Backward"');
    expect(plan).not.toContain('"Node Type":"Sort"');
    expect(plan).not.toContain('"Node Type":"Incremental Sort"');
  });
});
