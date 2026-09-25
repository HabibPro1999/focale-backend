import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ execute: vi.fn(), transaction: vi.fn(), purge: vi.fn() }));
vi.mock("../client", () => ({ getDb: () => mocks }));
vi.mock("./networking-retention", () => ({ purgeExpiredNetworkingEvents: mocks.purge }));
import { maintainNetworkingLifecycle } from "./networking-maintenance";
it("purges events past retention through the batched, resumable purge, scoped like the rest of maintenance", async () => {
  mocks.execute.mockReset().mockResolvedValue({ rows: [] });
  await maintainNetworkingLifecycle("event");
  expect(mocks.purge).toHaveBeenCalledWith({ eventId: "event" });
  // No purge work happens inline any more (no profile deletes, no transaction).
  expect(mocks.transaction).not.toHaveBeenCalled();
  mocks.purge.mockClear();
  await maintainNetworkingLifecycle();
  expect(mocks.purge).toHaveBeenCalledWith({ eventId: undefined });
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
