import { beforeEach, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
const db = vi.hoisted(() => ({
  transaction: vi.fn(), execute: vi.fn(), insert: vi.fn(), values: vi.fn(), onConflictDoNothing: vi.fn(),
  returning: vi.fn(), select: vi.fn(), from: vi.fn(), where: vi.fn(), update: vi.fn(), set: vi.fn(),
}));
vi.mock("../client", () => ({ getDb: () => db }));
import { beginNetworkingEmailLog, finishNetworkingEmailLog } from "./networking-email-tracking";
import type { NetworkingDeliveryRow } from "./networking-delivery";
const row = { id: "delivery", eventId: "event", payload: {}, attempts: 2, lockedUntil: new Date(Date.now() + 300000) } as NetworkingDeliveryRow;
const input = { registrationId: "registration", recipientEmail: "test@example.test", recipientName: "Test", subject: "Subject" };
beforeEach(() => {
  vi.resetAllMocks();
  db.transaction.mockImplementation((run) => run(db));
  db.execute.mockResolvedValue({ rows: [{ id: row.id }] });
  for (const method of ["insert", "values", "onConflictDoNothing", "select", "from", "update", "set"] as const) db[method].mockReturnValue(db);
  db.returning.mockResolvedValue([]);
  db.where.mockResolvedValue([{ status: "SENDING", lockedUntil: row.lockedUntil }]);
});
it("refuses a second live SENDING log without updating it", async () => {
  expect(await beginNetworkingEmailLog(row, input)).toMatchObject({ alreadySent: false, leaseLost: true });
  expect(db.update).not.toHaveBeenCalled();
});
it("allows the newly inserted owner and an expired SENDING retry", async () => {
  db.returning.mockResolvedValueOnce([{ id: row.id }]);
  expect(await beginNetworkingEmailLog(row, input)).toEqual({ alreadySent: false });
  db.where.mockResolvedValue([{ status: "SENDING", lockedUntil: new Date(0) }]);
  expect(await beginNetworkingEmailLog(row, input)).toEqual({ alreadySent: false });
});
it("fences all begin and finish writes with the exact unexpired delivery lease under a row lock", async () => {
  db.execute.mockResolvedValue({ rows: [] });
  expect(await beginNetworkingEmailLog(row, input)).toMatchObject({ leaseLost: true });
  for (const outcome of ["sent", "failed", "skipped"] as const) await finishNetworkingEmailLog(row, outcome);
  expect(db.insert).not.toHaveBeenCalled();
  expect(db.update).not.toHaveBeenCalled();
  for (const [query] of db.execute.mock.calls) {
    const compiled = new PgDialect().sqlToQuery(query);
    expect(compiled.sql).toContain("locked_until=");
    expect(compiled.sql).toContain("locked_until>now() FOR UPDATE");
    expect(compiled.params).toContain(row.lockedUntil!.toISOString());
  }
});
