import { beforeEach, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
const mocks = vi.hoisted(() => ({ update: vi.fn(), set: vi.fn(), where: vi.fn(), returning: vi.fn() }));
vi.mock("../client", () => ({ getDb: () => mocks }));
import { claimNetworkingDeliveries, refreshNetworkingDeliveryLease, type NetworkingDeliveryRow } from "./networking-delivery";
const dialect = new PgDialect({ casing: "snake_case" });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.update.mockReturnValue(mocks); mocks.set.mockReturnValue(mocks); mocks.where.mockReturnValue(mocks);
});
it("returns complete claimed rows directly from the atomic update, without a second select", async () => {
  const rows = [{ id: "delivery", payload: { messageId: "message" }, lockedUntil: new Date() }];
  mocks.returning.mockResolvedValue(rows);
  expect(await claimNetworkingDeliveries(4, "event")).toBe(rows);
  expect(mocks.update).toHaveBeenCalledOnce();
  expect(mocks.returning).toHaveBeenCalledWith();
  const query = dialect.sqlToQuery(mocks.where.mock.calls[0][0]);
  expect(query.sql).toContain("FOR UPDATE SKIP LOCKED");
  expect(query.params).toContain("event");
  expect(dialect.sqlToQuery(mocks.set.mock.calls[0][0].lockedUntil).sql).toContain("date_trunc('milliseconds',now())");
});
it.each([
  ["otp", "type = 'OTP'"],
  ["other", "type <> 'OTP'"],
] as const)("the %s lane repeats its partial claim index predicate (0031), oldest due first", async (lane, typeClause) => {
  mocks.returning.mockResolvedValue([]);
  await claimNetworkingDeliveries(10, undefined, lane);
  const query = dialect.sqlToQuery(mocks.where.mock.calls[0][0]);
  const where = query.sql.replace(/\s+/g, " ");
  // Same text as the index predicate, so both engines can prove the index applies.
  expect(where).toContain(`WHERE ${typeClause} AND status IN ('PENDING', 'PROCESSING', 'FAILED') AND attempts < 5`);
  expect(where).toContain("AND (status <> 'PROCESSING' OR locked_until < now()) AND available_at <= now()");
  expect(where).toContain("ORDER BY available_at LIMIT");
  expect(where).not.toContain("CASE WHEN");
  expect(query.params).toEqual([10]);
});
it("failed compare-and-set renewal never adopts another worker's lease", async () => {
  const lockedUntil = new Date("2030-01-01T00:05:00Z");
  const row = { id: "delivery", lockedUntil } as NetworkingDeliveryRow;
  mocks.returning.mockResolvedValue([]);
  expect(await refreshNetworkingDeliveryLease(row)).toBe(false);
  expect(row.lockedUntil).toBe(lockedUntil);
  const query = dialect.sqlToQuery(mocks.where.mock.calls[0][0]);
  expect(query.sql).toContain('"locked_until" =');
  expect(query.sql).toContain('"locked_until" >');
  expect(query.params).toContain(lockedUntil.toISOString());
});
