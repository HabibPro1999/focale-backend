import { beforeEach, expect, it, vi } from "vitest";
import { NetworkingConfigSchema } from "@app/contracts";
const mocks = vi.hoisted(() => ({ connections: vi.fn(), meetings: vi.fn(), connectionCount: vi.fn(), meetingCount: vi.fn() }));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  listNetworkingConnectionSummaries: mocks.connections,
  listNetworkingParticipantMeetings: mocks.meetings,
  countNetworkingConnectionSummaries: mocks.connectionCount,
  countNetworkingParticipantMeetings: mocks.meetingCount,
}));
import { participantPagination } from "./networking.pagination";
import { NetworkingSocialService } from "./networking.social.service";
import { NetworkingMeetingsService } from "./networking.meetings.service";
import type { NetworkingContext, NetworkingService } from "./networking.service";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ctx = { event: { id: id(100) }, profile: { id: id(101) }, config: NetworkingConfigSchema.parse({}) } as NetworkingContext;
const at = new Date("2030-01-01T00:00:00.000Z");
const invalid = { status: 400, response: expect.objectContaining({ code: "NETWORKING_VALIDATION" }) };
beforeEach(() => vi.clearAllMocks());

it("always paginates: default 50 without a query, 50 for cursor-only, and accepts 200", () => {
  expect(participantPagination("meetings", ctx)).toMatchObject({ limit: 50, after: undefined });
  const page = participantPagination("meetings", ctx, { limit: 200 });
  expect(page.limit).toBe(200);
  const cursor = page.cursor(at, id(1));
  expect(participantPagination("meetings", ctx, { cursor })).toMatchObject({ limit: 50, after: { at, id: id(1) } });
});
it.each([0, -1, 201, 1.5, NaN, Infinity])("rejects invalid limit %s", (limit) => {
  expect(() => participantPagination("meetings", ctx, { limit })).toThrow(expect.objectContaining(invalid));
});
it.each(["", "!bad", "a".repeat(2049), "bnVsbA", "e30", "W10"]) ("rejects malformed cursor %s", (cursor) => {
  expect(() => participantPagination("meetings", ctx, { cursor })).toThrow(expect.objectContaining(invalid));
});
it("rejects cross-event/profile/endpoint cursors and malformed decoded fields, but survives organizer config edits", () => {
  const cursor = participantPagination("connections", ctx, { limit: 1 }).cursor(at, id(1));
  for (const [kind, context] of [
    ["meetings", ctx],
    ["connections", { ...ctx, event: { id: id(200) } }],
    ["connections", { ...ctx, profile: { id: id(201) } }],
  ] as const) expect(() => participantPagination(kind, context as NetworkingContext, { cursor })).toThrow(expect.objectContaining(invalid));
  const edited = { ...ctx, config: { ...ctx.config, eligiblePaymentStatuses: ["PAID"] } } as NetworkingContext;
  expect(participantPagination("connections", edited, { cursor }).after).toEqual({ at, id: id(1) });
  const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
  for (const patch of [{ id: 1 }, { id: "bad" }, { at: 1 }, { at: "2030-02-30T00:00:00.000Z" }, { at: "invalid" }, { scope: 1 }, { version: 2 }, { extra: true }]) {
    const altered = Buffer.from(JSON.stringify({ ...decoded, ...patch })).toString("base64url");
    expect(() => participantPagination("connections", ctx, { cursor: altered })).toThrow(expect.objectContaining(invalid));
  }
});

it.each(["connections", "meetings"] as const)("%s paginates equal sort keys without duplicates/skips, preserves hydration, and counts only on the first page", async (kind) => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: id(i + 1), createdAt: at, startsAt: at, profile: { id: id(i + 10), firstName: "Visible", overrides: {} } }));
  const ordered = kind === "connections" ? [...rows].reverse() : rows;
  const read = kind === "connections" ? mocks.connections : mocks.meetings;
  read.mockImplementation(async (...args) => {
    const page = args[kind === "connections" ? 3 : 2];
    if (!page) return ordered;
    return ordered.filter(row => !page.after || (kind === "connections" ? row.id < page.after.id : row.id > page.after.id)).slice(0, page.limit + 1);
  });
  const count = kind === "connections" ? mocks.connectionCount : mocks.meetingCount;
  count.mockResolvedValue(5);
  const social = new NetworkingSocialService({} as NetworkingService);
  const meetings = new NetworkingMeetingsService({} as NetworkingService);
  const expire = vi.spyOn(meetings, "expire").mockResolvedValue(undefined);
  const hydrate = vi.spyOn(meetings, "hydrate").mockImplementation(async (row) => ({ ...row, table: { space: { name: "Hall" } } }) as any);
  const list = (query = {}) => kind === "connections" ? social.connections(ctx, query) : meetings.list(ctx, query);
  let cursor: string | undefined;
  const seen: string[] = [];
  const pages: object[] = [];
  for (const size of [2, 2, 1]) {
    const result = await list({ limit: 2, cursor });
    pages.push(result);
    expect(result.items).toHaveLength(size);
    seen.push(...result.items.map(row => row.id));
    cursor = result.nextCursor ?? undefined;
    if (kind === "meetings") expect(result.items[0]).toHaveProperty("table.space.name", "Hall");
    else expect(result.items[0]).toHaveProperty("profile.firstName", "Visible");
  }
  expect(cursor).toBeUndefined();
  expect(seen).toEqual(ordered.map(row => row.id));
  expect(pages.map(page => Object.keys(page).sort())).toEqual([["items", "nextCursor", "total"], ["items", "nextCursor"], ["items", "nextCursor"]]);
  expect((pages[0] as { total: number }).total).toBe(5);
  expect(count).toHaveBeenCalledOnce();
  if (kind === "meetings") {
    expect(hydrate).toHaveBeenCalledTimes(5);
    expect(expire).toHaveBeenCalledOnce();
  }
  const finalCursor = participantPagination(kind, ctx, { limit: 2 }).cursor(at, ordered.at(-1)!.id);
  expect(await list({ cursor: finalCursor })).toEqual({ items: [], nextCursor: null });
  expect(await list()).toMatchObject({ total: 5, nextCursor: null });
  expect(read).toHaveBeenLastCalledWith(ctx.event.id, ctx.profile.id, ...(kind === "connections" ? [ctx.config.eligiblePaymentStatuses] : []), expect.objectContaining({ limit: 50 }));
});

it.each(["connections", "meetings"] as const)("internal %s export listing is never truncated to a page", async (kind) => {
  const rows = Array.from({ length: 137 }, (_, i) => ({ id: id(i + 1), createdAt: at, startsAt: at, profile: { id: id(i + 1000), overrides: {} } }));
  (kind === "connections" ? mocks.connections : mocks.meetings).mockResolvedValue(rows);
  const social = new NetworkingSocialService({} as NetworkingService);
  const meetings = new NetworkingMeetingsService({} as NetworkingService);
  vi.spyOn(meetings, "expire").mockResolvedValue(undefined);
  vi.spyOn(meetings, "hydrate").mockImplementation(async (row) => row as any);
  const items = kind === "connections" ? await social.allConnections(ctx) : await meetings.allMeetings(ctx);
  expect(items).toHaveLength(137);
  expect(kind === "connections" ? mocks.connections : mocks.meetings).toHaveBeenCalledWith(ctx.event.id, ctx.profile.id, ...(kind === "connections" ? [ctx.config.eligiblePaymentStatuses] : []));
});
