import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { getTableName, type SQL, type Table } from "drizzle-orm";
import type { DbExecutor } from "../client";
import { cancelNetworkingParticipantMeetings } from "./networking";

const compiled = (predicate: SQL) => new PgDialect({ casing: "snake_case" }).sqlToQuery(predicate);

function fakeDb(meetings: Record<string, unknown>[]) {
  const updates: SQL[] = [];
  const deletes: SQL[] = [];
  const selects: string[] = [];
  const notifications: Record<string, unknown>[] = [];
  const db = {
    update: vi.fn(() => ({
      set: () => ({ where: (predicate: SQL) => { updates.push(predicate); return { returning: async () => meetings }; } }),
    })),
    delete: vi.fn(() => ({ where: async (predicate: SQL) => { deletes.push(predicate); } })),
    select: vi.fn(() => ({ from: (table: Table) => { selects.push(getTableName(table)); return { where: async () => [{ slug: "from-db" }] }; } })),
    insert: vi.fn((table: Table) => ({
      values: (values: Record<string, unknown>) => {
        if (getTableName(table) === "networking_notifications") notifications.push(values);
        const row = { id: `n${notifications.length}`, ...values, data: values.data ?? {} };
        return { returning: async () => [row], onConflictDoNothing: () => ({ returning: async () => [row] }) };
      },
    })),
  };
  return { db: db as unknown as DbExecutor, updates, deletes, selects, notifications };
}

// As the CANCEL transition's UPDATE … RETURNING returns it.
const meeting = (id: string) => ({
  id, requesterId: "a", recipientId: "b", revision: 3, status: "CANCELLED",
  startsAt: new Date("2099-01-01T09:00:00Z"), endsAt: new Date("2099-01-01T09:30:00Z"),
});

describe("cancelNetworkingParticipantMeetings", () => {
  it("cancels only a blocked pair's active meetings with one UPDATE … RETURNING and one reservation delete", async () => {
    const { db, updates, deletes, selects, notifications } = fakeDb([meeting("m1"), meeting("m2")]);
    const rows = await cancelNetworkingParticipantMeetings("a", "event", db, { counterpartId: "b", slug: "demo" });
    expect(rows).toHaveLength(2);
    const where = compiled(updates[0]!);
    expect(where.params).toEqual(expect.arrayContaining(["event", "a", "b", "PENDING", "PENDING_ALLOCATION", "CONFIRMED"]));
    expect(where.sql).toMatch(/"requester_id" = \$\d+ and "networking_meetings"."recipient_id" = \$\d+/);
    expect(deletes).toHaveLength(1);
    expect(compiled(deletes[0]!).params).toEqual(["event", "m1", "m2"]);
    // The slug is passed in, so the event row is never read inside the networking transaction.
    expect(selects).toEqual([]);
    expect(notifications.map((row) => row.profileId)).toEqual(["a", "b", "a", "b"]);
    for (const row of notifications) {
      expect(row).toMatchObject({ type: "MEETING_CANCELLED", title: "Meeting cancelled", href: "/e/demo/agenda", data: { revision: 3, action: "CANCEL", status: "CANCELLED", reason: "UNAVAILABLE" } });
      expect(row.data).not.toHaveProperty("counterpartName");
      expect(row.data).not.toHaveProperty("tableName");
    }
  });
  it("covers every counterpart without a pair filter and reads the slug only when needed", async () => {
    const { db, updates, selects, notifications } = fakeDb([meeting("m1")]);
    await cancelNetworkingParticipantMeetings("a", "event", db);
    expect(compiled(updates[0]!).sql).toMatch(/"requester_id" = \$\d+ or "networking_meetings"."recipient_id" = \$\d+/);
    expect(selects).toEqual(["events"]);
    expect(notifications[0]).toMatchObject({ href: "/e/from-db/agenda" });
  });
  it("does nothing more when no meeting is active", async () => {
    const { db, deletes, notifications } = fakeDb([]);
    expect(await cancelNetworkingParticipantMeetings("a", "event", db, { slug: "demo" })).toEqual([]);
    expect(deletes).toEqual([]);
    expect(notifications).toEqual([]);
  });
});
