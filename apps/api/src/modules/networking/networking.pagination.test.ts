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

it("uses default 50 for cursor-only, accepts 200, and keeps missing pagination legacy", () => {
  expect(participantPagination("meetings", ctx)).toBeUndefined();
  const page = participantPagination("meetings", ctx, { limit: 200 })!;
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
it("rejects cross-event/profile/endpoint/eligibility cursors and malformed decoded fields", () => {
  const cursor = participantPagination("connections", ctx, { limit: 1 })!.cursor(at, id(1));
  for (const [kind, context] of [
    ["meetings", ctx],
    ["connections", { ...ctx, event: { id: id(200) } }],
    ["connections", { ...ctx, profile: { id: id(201) } }],
    ["connections", { ...ctx, config: { ...ctx.config, eligiblePaymentStatuses: [] } }],
  ] as const) expect(() => participantPagination(kind, context as NetworkingContext, { cursor })).toThrow(expect.objectContaining(invalid));
  const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
  for (const patch of [{ id: 1 }, { id: "bad" }, { at: 1 }, { at: "2030-02-30T00:00:00.000Z" }, { at: "invalid" }, { scope: 1 }, { version: 2 }, { extra: true }]) {
    const altered = Buffer.from(JSON.stringify({ ...decoded, ...patch })).toString("base64url");
    expect(() => participantPagination("connections", ctx, { cursor: altered })).toThrow(expect.objectContaining(invalid));
  }
});

it.each(["connections", "meetings"] as const)("%s paginates equal sort keys without duplicates/skips, preserves hydration, total and legacy shape", async (kind) => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: id(i + 1), createdAt: at, startsAt: at, profile: { id: id(i + 10), firstName: "Visible", overrides: {} } }));
  const ordered = kind === "connections" ? [...rows].reverse() : rows;
  const read = kind === "connections" ? mocks.connections : mocks.meetings;
  read.mockImplementation(async (...args) => {
    const page = args[kind === "connections" ? 3 : 2];
    if (!page) return rows;
    return ordered.filter(row => !page.after || (kind === "connections" ? row.id < page.after.id : row.id > page.after.id)).slice(0, page.limit + 1);
  });
  (kind === "connections" ? mocks.connectionCount : mocks.meetingCount).mockResolvedValue(5);
  const social = new NetworkingSocialService({} as NetworkingService);
  const meetings = new NetworkingMeetingsService({} as NetworkingService);
  vi.spyOn(meetings, "expire").mockResolvedValue(undefined as never);
  const hydrate = vi.spyOn(meetings, "hydrate").mockImplementation(async (row) => ({ ...row, table: { space: { name: "Hall" } } }) as any);
  const list = (query = {}) => kind === "connections" ? social.connections(ctx, query) : meetings.list(ctx, query);
  let cursor: string | undefined;
  const seen: string[] = [];
  for (const size of [2, 2, 1]) {
    const result = await list({ limit: 2, cursor });
    expect(result.items).toHaveLength(size);
    expect(result.total).toBe(5);
    seen.push(...result.items.map(row => row.id));
    cursor = (result as { nextCursor: string | null }).nextCursor ?? undefined;
    if (kind === "meetings") expect(result.items[0]).toHaveProperty("table.space.name", "Hall");
    else expect(result.items[0]).toHaveProperty("profile.firstName", "Visible");
  }
  expect(cursor).toBeUndefined();
  expect(seen).toEqual(ordered.map(row => row.id));
  if (kind === "meetings") expect(hydrate).toHaveBeenCalledTimes(5);
  const finalCursor = participantPagination(kind, ctx, { limit: 2 })!.cursor(at, ordered.at(-1)!.id);
  expect(await list({ cursor: finalCursor })).toEqual({ items: [], total: 5, nextCursor: null });
  const legacy = await list();
  expect(Object.keys(legacy).sort()).toEqual(["items", "total"]);
  expect(legacy.items.map(row => row.id)).toEqual(rows.map(row => row.id));
  expect(legacy.total).toBe(5);
  expect(read).toHaveBeenLastCalledWith(ctx.event.id, ctx.profile.id, ...(kind === "connections" ? [ctx.config.eligiblePaymentStatuses] : []), undefined);
});
