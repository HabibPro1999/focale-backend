import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ execute: vi.fn(), transaction: vi.fn() }));
vi.mock("../client", () => ({ getDb: () => mocks }));
import { maintainNetworkingLifecycle } from "./networking-maintenance";
function retentionHarness(failCommit = false) {
  const profiles = [{ id: "p", photoUrl: "https://storage.test/p.webp" }, { id: "q", photoUrl: null }];
  const state = { inTransaction: false, committed: false, rolledBack: false };
  mocks.execute.mockImplementation(async (query) => {
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const text = new PgDialect().sqlToQuery(query).sql;
    return { rows: text.startsWith("SELECT c.event_id") ? [{ event_id: "event" }] : [] };
  });
  const deleted = vi.fn().mockResolvedValue(undefined);
  mocks.transaction.mockImplementation(async (run) => {
    state.inTransaction = true;
    try {
      const result = await run({
        execute: vi.fn(),
        select: () => ({ from: () => ({ where: async () => profiles }) }),
        delete: () => ({ where: deleted }),
      });
      if (failCommit) throw new Error("commit failed");
      state.committed = true;
      return result;
    } catch (error) {
      state.rolledBack = true;
      throw error;
    } finally {
      state.inTransaction = false;
    }
  });
  return { profiles, state, deleted };
}

it("invokes photo storage cleanup only after the purge transaction commits", async () => {
  const { profiles, state, deleted } = retentionHarness();
  const storageDelete = vi.fn(async () => {
    expect(state.inTransaction).toBe(false);
    expect(state.committed).toBe(true);
    // Profiles (cascading) and the event's allocation lock rows.
    expect(deleted).toHaveBeenCalledTimes(2);
  });
  const afterPurge = vi.fn(async (rows) => {
    expect(rows).toEqual(profiles);
    await storageDelete();
  });
  await maintainNetworkingLifecycle("event", afterPurge);
  expect(afterPurge).toHaveBeenCalledOnce();
  expect(storageDelete).toHaveBeenCalledOnce();
  expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "serializable" });
});

it("never invokes cleanup when the purge transaction rolls back", async () => {
  const { state, deleted } = retentionHarness(true);
  const afterPurge = vi.fn();
  await expect(maintainNetworkingLifecycle("event", afterPurge)).rejects.toThrow("commit failed");
  expect(deleted).toHaveBeenCalledTimes(2);
  expect(state.rolledBack).toBe(true);
  expect(state.committed).toBe(false);
  expect(afterPurge).not.toHaveBeenCalled();
});

it("cleanup failure cannot roll back the committed purge", async () => {
  const { state, deleted } = retentionHarness();
  const afterPurge = vi.fn(async () => {
    expect(state.inTransaction).toBe(false);
    throw new Error("storage unavailable");
  });
  await expect(maintainNetworkingLifecycle("event", afterPurge)).rejects.toThrow("storage unavailable");
  expect(deleted).toHaveBeenCalledTimes(2);
  expect(state.committed).toBe(true);
  expect(state.rolledBack).toBe(false);
});

it("queues automatic reports and contacts only at end +24 hours, retaining dedupe", async () => {
  const { PgDialect } = await import("drizzle-orm/pg-core");
  mocks.execute.mockReset().mockResolvedValue({ rows: [] });
  await maintainNetworkingLifecycle("event");
  const queries = mocks.execute.mock.calls.map(([query]) => new PgDialect().sqlToQuery(query).sql);
  for (const type of ["POST_EVENT_REPORT", "POST_EVENT_CONTACTS"]) {
    const query = queries.find((text) => text.includes(type) && text.includes("FROM events e") ||
      (text.includes(type) && text.includes("WITH candidates AS") && text.includes("end_date")))!;
    expect(query).toContain("e.end_date+interval '24 hours'<=now()");
    expect(query).toContain("ON CONFLICT (dedupe_key) DO NOTHING");
    // The SQL boundary includes exactly +24 h, not event end or the preceding millisecond.
    const end = Date.parse("2030-01-01T00:00:00Z");
    const delay = Number(query.match(/interval '(\d+) hours'/)![1]) * 3600000;
    expect(end + delay <= end + 24 * 3600000 - 1).toBe(false);
    expect(end + delay <= end + 24 * 3600000).toBe(true);
  }
});
