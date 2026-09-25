import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";

const dbMock = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../client", () => ({ getDb: () => dbMock }));

import { DB_NOW, backoffInterval, createLeaseQueue, type LeaseQueueSpec } from "./lease-queue";

const dialect = new PgDialect();
const queryOf = (i: number) => dialect.sqlToQuery(dbMock.execute.mock.calls[i]![0] as SQL);
const flat = (text: string) => text.replace(/\s+/g, " ");

const spec: LeaseQueueSpec = {
  name: "test",
  table: "jobs",
  leasedStatus: "RUNNING",
  leaseMs: 90_000,
  claimable: sql`"status" = 'PENDING' AND ("next_attempt_at" IS NULL OR "next_attempt_at" <= ${DB_NOW})`,
  order: sql`"created_at" ASC`,
  claimSet: sql`"error_message" = NULL`,
  releaseSet: sql`"status" = 'PENDING'`,
  recovery: {
    exhausted: sql`"attempt_count" >= "max_attempts"`,
    retrySet: sql`"status" = 'PENDING'`,
    deadSet: sql`"status" = 'FAILED'`,
    exclude: sql`"owner" = 'other'`,
  },
};

describe("createLeaseQueue SQL", () => {
  beforeEach(() => {
    dbMock.execute.mockReset();
    dbMock.execute.mockResolvedValue({ rowCount: 1, rows: [{ id: "a" }] });
  });

  it("claims with SKIP LOCKED in spec order, charging the attempt and timing the lease on the DB clock", async () => {
    const queue = createLeaseQueue(spec);
    await expect(queue.claim("w1", 5)).resolves.toEqual(["a"]);
    const { sql: text, params } = queryOf(0);
    expect(flat(text)).toContain(`UPDATE "jobs" SET "status" = $1`);
    expect(flat(text)).toContain(`"attempt_count" = "attempt_count" + 1`);
    expect(flat(text)).toContain(`"locked_until" = (statement_timestamp() AT TIME ZONE 'UTC') + $`);
    expect(flat(text)).toContain(`, "error_message" = NULL WHERE "id" IN ( SELECT "id" FROM "jobs" WHERE ("status" = 'PENDING'`);
    expect(flat(text)).toContain(`ORDER BY "created_at" ASC LIMIT $`);
    expect(flat(text)).toContain("FOR UPDATE SKIP LOCKED");
    expect(params).toEqual(["RUNNING", "90 seconds", "w1", 5]);
    // No application clock anywhere.
    expect(params.some((p) => p instanceof Date)).toBe(false);
  });

  it("does not query for an empty claim, renewal or release", async () => {
    const queue = createLeaseQueue(spec);
    await expect(queue.claim("w1", 0)).resolves.toEqual([]);
    await expect(queue.renew("w1", [])).resolves.toEqual([]);
    await expect(queue.release("w1", [])).resolves.toBe(0);
    expect(dbMock.execute).not.toHaveBeenCalled();
  });

  it("fences renew, confirm, complete, fail and release by ownership", async () => {
    const queue = createLeaseQueue(spec);
    await queue.renew("w1", ["a", "b"], 30_000);
    await queue.confirm("w1", "a");
    await queue.complete("w1", "a", sql`"status" = 'DONE'`);
    await queue.fail("w1", "a", sql`"status" = 'FAILED'`);
    await queue.release("w1", ["a"]);
    for (let i = 0; i < 5; i++) {
      const { sql: text, params } = queryOf(i);
      expect(flat(text)).toMatch(/AND "status" = \$\d+ AND "locked_by" = \$\d+ RETURNING "id"/);
      expect(params).toEqual(expect.arrayContaining(["RUNNING", "w1"]));
    }
    expect(queryOf(0).params).toEqual(["30 seconds", "a", "b", "RUNNING", "w1"]);
    expect(flat(queryOf(2).sql)).toContain(`SET "status" = 'DONE', "locked_at" = NULL, "locked_until" = NULL, "locked_by" = NULL`);
    // Release refunds the claim's attempt and clears the lease.
    expect(flat(queryOf(4).sql)).toContain(
      `SET "status" = 'PENDING', "attempt_count" = GREATEST("attempt_count" - 1, 0), "locked_at" = NULL`,
    );
  });

  it("recovers only expired leases outside the exclusion, split by exhaustion", async () => {
    dbMock.execute.mockResolvedValueOnce({ rowCount: 2, rows: [] }).mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const queue = createLeaseQueue(spec);
    await expect(queue.recoverStale()).resolves.toEqual({ requeued: 2, deadLettered: 1 });
    const retry = flat(queryOf(0).sql);
    const dead = flat(queryOf(1).sql);
    for (const text of [retry, dead]) {
      expect(text).toContain(`"locked_until" < (statement_timestamp() AT TIME ZONE 'UTC')`);
      expect(text).toContain(`NOT ("owner" = 'other')`);
    }
    expect(retry).toContain(`SET "status" = 'PENDING'`);
    expect(retry).toContain(`AND NOT ("attempt_count" >= "max_attempts")`);
    expect(dead).toContain(`SET "status" = 'FAILED'`);
    expect(dead).toContain(`AND ("attempt_count" >= "max_attempts")`);
  });

  it("parks the uncertain rows first and keeps them out of requeue and dead-letter", async () => {
    dbMock.execute
      .mockResolvedValueOnce({ rowCount: 3, rows: [] })
      .mockResolvedValueOnce({ rowCount: 2, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const queue = createLeaseQueue({
      ...spec,
      recovery: { ...spec.recovery, uncertain: { where: sql`"sent_at" IS NOT NULL`, set: sql`"status" = 'UNKNOWN'` } },
    });
    await expect(queue.recoverStale()).resolves.toEqual({ requeued: 2, deadLettered: 1, uncertain: 3 });
    const parked = flat(queryOf(0).sql);
    expect(parked).toContain(`SET "status" = 'UNKNOWN', "locked_at" = NULL`);
    expect(parked).toContain(`NOT ("owner" = 'other') AND COALESCE(("sent_at" IS NOT NULL), FALSE)`);
    for (const i of [1, 2]) {
      expect(flat(queryOf(i).sql)).toContain(`AND NOT COALESCE(("sent_at" IS NOT NULL), FALSE) AND`);
    }
  });

  it("releases only the rows the spec lets go", async () => {
    const queue = createLeaseQueue({ ...spec, releasable: sql`"sent_at" IS NULL` });
    await queue.release("w1", ["a"]);
    expect(flat(queryOf(0).sql)).toMatch(/AND "locked_by" = \$\d+ AND \("sent_at" IS NULL\) RETURNING "id"/);
  });

  it("narrows recovery to the given rows", async () => {
    dbMock.execute.mockResolvedValue({ rowCount: 0, rows: [] });
    await createLeaseQueue(spec).recoverStale(sql`"event_id" = ${"event-1"}`);
    for (const i of [0, 1]) {
      const { sql: text, params } = queryOf(i);
      expect(flat(text)).toMatch(/NOT \("owner" = 'other'\) AND \("event_id" = \$\d+\)/);
      expect(params).toContain("event-1");
    }
  });

  it("builds a stepped backoff interval keyed on the attempt number", () => {
    const { sql: text, params } = dialect.sqlToQuery(backoffInterval(sql`"attempt_count"`, [60_000, 300_000, 900_000]));
    expect(flat(text)).toBe(
      `(CASE WHEN "attempt_count" <= 1 THEN $1::interval WHEN "attempt_count" <= 2 THEN $2::interval ELSE $3::interval END)`,
    );
    expect(params).toEqual(["60 seconds", "300 seconds", "900 seconds"]);
    expect(dialect.sqlToQuery(backoffInterval(sql`"n"`, [5_000])).params).toEqual(["5 seconds"]);
    expect(() => backoffInterval(sql`"n"`, [])).toThrow();
  });

  it("reports health counts and the oldest lease age", async () => {
    dbMock.execute.mockResolvedValueOnce({ rows: [{ claimable: "3", leased: 2, expired: 1, age: "1234.4" }] });
    await expect(createLeaseQueue(spec).health()).resolves.toEqual({
      claimable: 3,
      leased: 2,
      expiredLeases: 1,
      oldestLeaseAgeMs: 1234,
    });
  });
});
