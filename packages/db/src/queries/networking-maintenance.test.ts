import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ execute: vi.fn(), transaction: vi.fn() }));
vi.mock("../client", () => ({ getDb: () => mocks }));
import { maintainNetworkingLifecycle } from "./networking-maintenance";
it("exposes profile photos before retention deletes their rows", async () => {
  const profiles = [{ id: "p", photoUrl: "https://storage.test/p.webp" }, { id: "q", photoUrl: null }];
  mocks.execute.mockResolvedValue({ rows: [] });
  // Retention discovery is the final execute outside the transaction.
  mocks.execute.mockImplementation(async (query) => {
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const text = new PgDialect().sqlToQuery(query).sql;
    return { rows: text.startsWith("SELECT c.event_id") ? [{ event_id: "event" }] : [] };
  });
  const deleted = vi.fn().mockResolvedValue(undefined);
  const beforePurge = vi.fn(async (rows) => {
    expect(deleted).not.toHaveBeenCalled();
    expect(rows).toEqual(profiles);
  });
  const selected = vi.fn().mockResolvedValue(profiles);
  mocks.transaction.mockImplementation(async (run) => run({
    execute: vi.fn(),
    select: () => ({ from: () => ({ where: selected }) }),
    delete: () => ({ where: deleted }),
  }));
  await maintainNetworkingLifecycle("event", beforePurge);
  expect(beforePurge).toHaveBeenCalledOnce();
  expect(selected).toHaveBeenCalledOnce();
  expect(deleted).toHaveBeenCalledOnce();
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
