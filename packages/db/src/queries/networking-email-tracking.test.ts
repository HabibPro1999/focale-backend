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
it("reuses an existing SENDING log from an expired earlier attempt instead of refusing it", async () => {
  db.where.mockResolvedValue([{ status: "SENDING", lockedUntil: new Date(Date.now() + 60_000) }]);
  expect(await beginNetworkingEmailLog(row, input)).toEqual({ alreadySent: false });
  expect(db.set).toHaveBeenCalledWith(expect.objectContaining({ status: "SENDING", lockedUntil: row.lockedUntil }));
});
it("reports an already provider-accepted log so the worker never resends it", async () => {
  for (const status of ["SENT", "DELIVERED", "OPENED"]) {
    db.where.mockResolvedValue([{ status }]);
    expect(await beginNetworkingEmailLog(row, input)).toEqual({ alreadySent: true });
  }
  expect(db.update).not.toHaveBeenCalled();
});
it("fences begin and failed/skipped finishes with the exact unexpired delivery lease under a row lock", async () => {
  db.execute.mockResolvedValue({ rows: [] });
  expect(await beginNetworkingEmailLog(row, input)).toMatchObject({ leaseLost: true });
  for (const outcome of ["failed", "skipped"] as const) await finishNetworkingEmailLog(row, outcome);
  expect(db.insert).not.toHaveBeenCalled();
  expect(db.update).not.toHaveBeenCalled();
  expect(db.execute).toHaveBeenCalledTimes(3);
  for (const [query] of db.execute.mock.calls) {
    const compiled = new PgDialect().sqlToQuery(query);
    expect(compiled.sql).toContain("locked_until=");
    expect(compiled.sql).toContain("locked_until>now() FOR UPDATE");
    expect(compiled.params).toContain(row.lockedUntil!.toISOString());
  }
});
it("records a provider-confirmed send after the lease was lost, upgrading a FAILED/SKIPPED log to SENT", async () => {
  db.execute.mockResolvedValue({ rows: [] });
  db.where.mockResolvedValue([]);
  await finishNetworkingEmailLog(row, "sent", "provider-message");
  expect(db.execute).not.toHaveBeenCalled();
  expect(db.set).toHaveBeenCalledWith(expect.objectContaining({ providerMessageId: "provider-message", lockedUntil: null }));
  expect(db.set).toHaveBeenCalledWith({ status: "SENT", failedAt: null });
  const upgrade = new PgDialect().sqlToQuery(db.where.mock.calls.at(-1)![0]);
  expect(upgrade.params).toEqual(expect.arrayContaining(["delivery", "SENDING", "FAILED", "SKIPPED"]));
  expect(upgrade.params).not.toContain("DELIVERED");
});
it("retries a serialization failure instead of dropping the sent record", async () => {
  const restart = Object.assign(new Error("restart transaction"), { code: "40001" });
  db.transaction.mockRejectedValueOnce(restart).mockImplementation((run) => run(db));
  db.where.mockResolvedValue([]);
  await finishNetworkingEmailLog(row, "sent", "message");
  expect(db.transaction).toHaveBeenCalledTimes(2);
});
