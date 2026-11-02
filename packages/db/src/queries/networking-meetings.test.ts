import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { NETWORKING_MEETING_STATUSES } from "@app/contracts";
import type { DbExecutor } from "../client";
import {
  NETWORKING_MEETING_GROUPS,
  NETWORKING_MEETING_TRANSITIONS,
  expireNetworkingProposals,
  networkingMeetingIs,
  networkingMeetingNotice,
  sweepReleasedNetworkingReservations,
  transitionNetworkingMeetings,
  type NetworkingMeetingRow,
} from "./networking-meetings";

const dialect = new PgDialect();
const text = (query: SQL) => dialect.sqlToQuery(query);
const row = (id: string, status: NetworkingMeetingRow["status"] = "CANCELLED") => ({
  id, eventId: "event", requesterId: "a", recipientId: "b", status, revision: 2, tableId: "t",
  startsAt: new Date("2031-01-01T10:00:00Z"), endsAt: new Date("2031-01-01T10:30:00Z"),
  proposedStartsAt: null, proposalBy: null,
}) as unknown as NetworkingMeetingRow;

/** Records the drizzle update/delete chains a transition builds. */
function fakeDb(returned: NetworkingMeetingRow[]) {
  const calls = { update: [] as { set: Record<string, unknown>; where: SQL }[], delete: [] as SQL[] };
  const db = {
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: (where: SQL) => ({ returning: async () => { calls.update.push({ set, where }); return returned; } }),
      }),
    }),
    delete: () => ({ where: async (where: SQL) => { calls.delete.push(where); } }),
  };
  return { db: db as unknown as DbExecutor, calls };
}

describe("meeting status groups", () => {
  it("split every status into holding or released, and keep attendance holding", () => {
    const { holding, released, open } = NETWORKING_MEETING_GROUPS;
    expect([...holding, ...released].sort()).toEqual([...NETWORKING_MEETING_STATUSES].sort());
    expect(holding.filter((status) => (released as readonly string[]).includes(status))).toEqual([]);
    expect(networkingMeetingIs("COMPLETED", "holding") && networkingMeetingIs("NO_SHOW", "holding")).toBe(true);
    for (const status of open) expect(networkingMeetingIs(status, "holding")).toBe(true);
  });
  it("only leave open statuses, and release exactly on cancel, decline and expiry", () => {
    for (const [name, { from, to }] of Object.entries(NETWORKING_MEETING_TRANSITIONS)) {
      for (const status of from) expect(networkingMeetingIs(status, "open")).toBe(true);
      expect(networkingMeetingIs(to, "released")).toBe(["CANCEL", "DECLINE", "EXPIRE"].includes(name));
    }
  });
});

describe("transitionNetworkingMeetings", () => {
  it("moves only rows in a source status and releases the reservations of exactly those rows", async () => {
    const { db, calls } = fakeDb([row("m1"), row("m2")]);
    const rows = await transitionNetworkingMeetings(db, "CANCEL", "event", ["m1", "m2", "m3"], { cancellationNote: "note" });
    expect(rows.map((r) => r.id)).toEqual(["m1", "m2"]);
    expect(calls.update[0]!.set).toMatchObject({ status: "CANCELLED", cancellationNote: "note" });
    const where = text(calls.update[0]!.where);
    expect(where.params).toEqual(["event", "PENDING", "PENDING_ALLOCATION", "CONFIRMED", "m1", "m2", "m3"]);
    expect(calls.delete).toHaveLength(1);
    expect(text(calls.delete[0]!).params).toEqual(["event", "m1", "m2"]);
  });
  it("keeps the reservations of attended meetings and does nothing when nothing moved", async () => {
    for (const transition of ["COMPLETED", "NO_SHOW"] as const) {
      const { db, calls } = fakeDb([row("m1", transition)]);
      await transitionNetworkingMeetings(db, transition, "event", ["m1"]);
      expect(text(calls.update[0]!.where).params).toEqual(["event", "CONFIRMED", "m1"]);
      expect(calls.delete).toEqual([]);
    }
    const none = fakeDb([]);
    await transitionNetworkingMeetings(none.db, "EXPIRE", "event", ["m1"]);
    expect(none.calls.delete).toEqual([]);
    const empty = fakeDb([row("m1")]);
    expect(await transitionNetworkingMeetings(empty.db, "CANCEL", "event", [])).toEqual([]);
    expect(empty.calls.update).toEqual([]);
  });
});

describe("expiry and the maintenance sweep", () => {
  const recorder = () => {
    const execute = vi.fn(async (_query: SQL) => ({ rows: [] }));
    return { db: { execute } as unknown as DbExecutor, queries: () => execute.mock.calls.map(([query]) => text(query)) };
  };
  it("expiry deletes only the reservations of the rows its UPDATE … RETURNING expired", async () => {
    const { db, queries } = recorder();
    await expireNetworkingProposals("event", db);
    const [expire, proposals] = queries();
    const sql = expire!.sql.replace(/\s+/g, " ");
    expect(sql).toMatch(/^ ?WITH expired AS \( UPDATE networking_meetings SET status=\$1,.* WHERE status IN \(\$2\) AND expires_at<=now\(\) AND event_id=\$3 RETURNING id \) DELETE FROM networking_reservations WHERE meeting_id IN \(SELECT id FROM expired\)$/);
    expect(expire!.params).toEqual(["EXPIRED", "PENDING", "event"]);
    expect(proposals!.sql).toContain("proposed_starts_at=NULL");
    // No sweep of released history on a read path.
    expect(queries()).toHaveLength(2);
    expect(queries().flatMap((query) => query.params)).not.toContain("CANCELLED");
  });
  it("the sweep deletes reservations still attached to any released meeting, scoped to the event", async () => {
    const { db, queries } = recorder();
    await sweepReleasedNetworkingReservations("event", db);
    const [sweep] = queries();
    expect(sweep!.sql).toContain("DELETE FROM networking_reservations r");
    expect(sweep!.params).toEqual(["CANCELLED", "DECLINED", "EXPIRED", "event"]);
  });
});

describe("networkingMeetingNotice", () => {
  it("gives cancellation notices their reason and keeps confidential ones anonymous", () => {
    const cancelled = row("m1");
    expect(networkingMeetingNotice(cancelled, "a", { type: "MEETING_CANCEL", slug: "s", reason: "ORGANIZER", counterpartName: "Bob B" }))
      .toMatchObject({ title: "Meeting update", href: "/e/s/agenda", data: { action: "CANCEL", reason: "ORGANIZER", counterpartName: "Bob B" } });
    expect(networkingMeetingNotice(row("m1", "CONFIRMED"), "a", { type: "MEETING_ACCEPT", slug: "s", reason: "ORGANIZER" }).data)
      .not.toHaveProperty("reason");
    const confidential = networkingMeetingNotice(cancelled, "b", {
      type: "MEETING_CANCELLED", slug: "s", confidential: true, counterpartName: "Alice A", tableName: "T1",
    });
    expect(confidential).toEqual({
      eventId: "event", profileId: "b", type: "MEETING_CANCELLED", href: "/e/s/agenda",
      title: "Meeting cancelled", body: "This meeting is no longer available.",
      data: {
        meetingId: "m1", revision: 2, action: "CANCEL", status: "CANCELLED", reason: "UNAVAILABLE",
        startsAt: "2031-01-01T10:00:00.000Z", endsAt: "2031-01-01T10:30:00.000Z",
      },
    });
  });
});
