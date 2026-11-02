import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ execute: vi.fn(), transaction: vi.fn(), purge: vi.fn(), erase: vi.fn() }));
vi.mock("../client", () => ({ getDb: () => mocks }));
vi.mock("./networking-retention", () => ({ purgeExpiredNetworkingEvents: mocks.purge }));
vi.mock("./networking-erasure", () => ({ eraseWithdrawnNetworkingProfiles: mocks.erase }));
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

it("erases withdrawn profiles past the configured window (default 30 days), after the purges", async () => {
  mocks.execute.mockReset().mockResolvedValue({ rows: [] });
  const order: string[] = [];
  mocks.purge.mockReset().mockImplementation(async () => { order.push("purge"); });
  mocks.erase.mockReset().mockImplementation(async () => { order.push("erase"); });
  await maintainNetworkingLifecycle("event", { withdrawalEraseDays: 7 });
  expect(mocks.erase).toHaveBeenCalledWith({ eraseDays: 7, eventId: "event" });
  expect(order).toEqual(["purge", "erase"]);
  mocks.erase.mockClear();
  await maintainNetworkingLifecycle();
  expect(mocks.erase).toHaveBeenCalledWith({ eraseDays: 30, eventId: undefined });
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

it("queues reminders, digests and contacts notices only through the eligibility policy (4.6)", async () => {
  const { PgDialect } = await import("drizzle-orm/pg-core");
  mocks.execute.mockReset().mockResolvedValue({ rows: [] });
  await maintainNetworkingLifecycle("event");
  const queries = mocks.execute.mock.calls.map(([query]) => new PgDialect({ casing: "snake_case" }).sqlToQuery(query));
  const producers = queries.filter((query) =>
    ["MEETING_REMINDER", "DAILY_DIGEST", "POST_EVENT_CONTACTS"].some((type) => query.sql.includes(type) || query.params.some((param) => String(param).includes(type))),
  );
  // Day and hour reminders, the digest and the contacts notice.
  expect(producers).toHaveLength(4);
  for (const query of producers) {
    // The gate: config, event, client and its modules.
    expect(query.sql).toContain(`"c"."config"->>'enabled'='true' AND "e"."status"<>'ARCHIVED'`);
    expect(query.params).toEqual(expect.arrayContaining(["networking", "registrations", "emails"]));
    // The recipient is eligible, never withdrawn or erased.
    for (const clause of [`"p"."status"='ACTIVE'`, `"p"."withdrawn_at" IS NULL`, `"p"."erased_at" IS NULL`, `"r"."event_id"="p"."event_id"`])
      expect(query.sql).toContain(clause);
  }
  // Reminders name the counterpart: it must be a peer (eligible, another person, unblocked).
  for (const reminder of producers.filter((query) => query.params.some((param) => String(param).startsWith("MEETING_REMINDER")))) {
    for (const clause of [`"peer"."erased_at" IS NULL`, `lower(btrim("peer"."email"))<>lower(btrim("p"."email"))`, "networking_blocks elig_b"])
      expect(reminder.sql).toContain(clause);
  }
});
