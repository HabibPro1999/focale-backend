import { describe, expect, it } from "vitest";
import type { DbExecutor } from "../client";
import { listEvents, countRegistrationsTx } from "./events";
import { countEventRegistrations, countCheckedInRegistrations, getAccessCheckInCounts } from "./checkin";
import { countRegistrationsWithAccess, countActiveSponsorshipsWithAccess } from "./access";
import { listNetworkingNotifications } from "./networking-participant-read";

/** Model pg's INT8 text result on CockroachDB, without querying a shared database. */
function executor(...responses: unknown[][]): DbExecutor {
  return { execute: async () => ({ rows: [{ count: "1" }] }), select() {
    const promise = Promise.resolve(responses.shift() ?? []);
    const query = {
      from: () => query, where: () => query, orderBy: () => query,
      limit: () => query, offset: () => query, innerJoin: () => query, groupBy: () => query,
      then: promise.then.bind(promise),
    };
    return query;
  } } as unknown as DbExecutor;
}

describe("numeric counts across PostgreSQL wire integer widths", () => {
  it("normalizes event list totals and event dependency counts", async () => {
    expect((await listEvents({ offset: 0, limit: 10 }, executor([], [{ value: "20" }]))).total).toBe(20);
    expect(await countRegistrationsTx(executor([{ value: "23" }]), "event")).toBe(23);
  });
  it("normalizes check-in totals and per-access counts", async () => {
    expect(await countEventRegistrations("event", executor([{ value: "23" }]))).toBe(23);
    expect(await countCheckedInRegistrations("event", executor([{ value: "20" }]))).toBe(20);
    expect(await getAccessCheckInCounts("event", executor([{ accessId: "access", count: "5" }]))).toEqual([{ accessId: "access", count: 5 }]);
  });
  it("normalizes the other raw access dependency counts", async () => {
    expect(await countRegistrationsWithAccess("access", executor([{ value: "2" }]))).toBe(2);
    expect(await countActiveSponsorshipsWithAccess("access", executor([{ value: "3" }]))).toBe(3);
  });
  it("normalizes the networking notification unread count", async () => {
    expect(await listNetworkingNotifications("event", "profile", 1, 30,
      executor([], [{ total: 4, unreadCount: "3" }])))
      .toMatchObject({ total: 4, unreadCount: 3, unreadMessageCount: 1 });
  });
});
