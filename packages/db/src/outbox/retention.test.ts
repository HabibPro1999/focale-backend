import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const dbMock = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../client", () => ({ getDb: () => dbMock }));

import { runOutboxRetention } from "./retention";

const dialect = new PgDialect();
const rendered = () =>
  dbMock.execute.mock.calls.map((c) => dialect.sqlToQuery(c[0] as SQL));

describe("runOutboxRetention", () => {
  beforeEach(() => dbMock.execute.mockReset());

  it("runs each step in batches until a batch comes back short", async () => {
    // realtime: 3 + 1 (short); background: 0; compaction: 3 + 3 + 2.
    for (const n of [3, 1, 0, 3, 3, 2]) dbMock.execute.mockResolvedValueOnce({ rowCount: n, rows: [] });
    await expect(runOutboxRetention({ batchSize: 3 })).resolves.toEqual({
      realtimeDeleted: 4,
      backgroundDeleted: 0,
      compacted: 8,
    });
    expect(dbMock.execute).toHaveBeenCalledTimes(6);
  });

  it("stops between batches once the signal aborts", async () => {
    const controller = new AbortController();
    dbMock.execute.mockImplementation(async () => {
      controller.abort();
      return { rowCount: 3, rows: [] };
    });
    await expect(runOutboxRetention({ batchSize: 3, signal: controller.signal })).resolves.toEqual({
      realtimeDeleted: 3,
      backgroundDeleted: 0,
      compacted: 0,
    });
    expect(dbMock.execute).toHaveBeenCalledOnce();
  });

  it("deletes realtime rows after 24 h, unkeyed finished background rows after 30 d, and only compacts keyed rows", async () => {
    dbMock.execute.mockResolvedValue({ rowCount: 0, rows: [] });
    await runOutboxRetention();
    const [realtime, background, compact] = rendered();

    expect(realtime!.sql).toMatch(/^\s*DELETE FROM "outbox_events"/);
    // networking.notify notices (4.3) expire like admin realtime events.
    expect(realtime!.sql).toContain(`"type" IN ('realtime.emit', 'networking.notify') AND "dedupe_key" IS NULL`);
    expect(realtime!.sql).toContain(`"status" <> 'PROCESSING'`);
    expect(realtime!.params).toEqual(["86400 seconds", 1000, "86400 seconds"]);

    expect(background!.sql).toMatch(/^\s*DELETE FROM "outbox_events"/);
    expect(background!.sql).toContain(`"type" NOT IN ('realtime.emit', 'networking.notify') AND "dedupe_key" IS NULL`);
    expect(background!.sql).toContain(`"status" IN ('PROCESSED', 'SKIPPED')`);
    expect(background!.params).toEqual(["2592000 seconds", 1000, "2592000 seconds"]);

    expect(compact!.sql).toMatch(/^\s*UPDATE "outbox_events" SET "payload" = '\{\}'::jsonb/);
    expect(compact!.sql).toContain(`"dedupe_key" IS NOT NULL`);
    expect(compact!.sql).toContain(`"payload" <> '{}'::jsonb`);
    expect(compact!.sql).not.toContain("DELETE");

    for (const q of [realtime!, background!, compact!]) {
      // Pick skips rows another transaction holds; the outer statement
      // re-checks the predicate on the rows it acts on.
      expect(q.sql).toContain("FOR UPDATE SKIP LOCKED");
      expect(q.sql).toMatch(/\) AND "/);
    }
  });
});
