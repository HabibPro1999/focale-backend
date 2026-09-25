import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const dbMock = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../client", () => ({ getDb: () => dbMock }));

import { runEmailSnapshotRetention } from "./email-retention";

const dialect = new PgDialect();
const rendered = () => dbMock.execute.mock.calls.map((c) => dialect.sqlToQuery(c[0] as SQL));

describe("runEmailSnapshotRetention (3.6b)", () => {
  beforeEach(() => dbMock.execute.mockReset());

  it("clears in batches until a batch comes back short", async () => {
    for (const n of [3, 3, 1]) dbMock.execute.mockResolvedValueOnce({ rowCount: n, rows: [] });
    await expect(runEmailSnapshotRetention({ fullPass: true, batchSize: 3 })).resolves.toEqual({
      cleared: 7,
      complete: true,
    });
    expect(dbMock.execute).toHaveBeenCalledTimes(3);
  });

  it("stops between batches once the signal aborts, as an incomplete pass", async () => {
    const controller = new AbortController();
    dbMock.execute.mockImplementation(async () => {
      controller.abort();
      return { rowCount: 3, rows: [] };
    });
    await expect(
      runEmailSnapshotRetention({ fullPass: true, batchSize: 3, signal: controller.signal }),
    ).resolves.toEqual({ cleared: 3, complete: false });
    expect(dbMock.execute).toHaveBeenCalledOnce();
  });

  it("clears finished, non-networking emails older than 90 days, keeping certificate ids", async () => {
    dbMock.execute.mockResolvedValue({ rowCount: 0, rows: [] });
    await runEmailSnapshotRetention({ fullPass: true });
    const [q] = rendered();

    expect(q!.sql).toMatch(/^\s*UPDATE "email_logs" SET "context_snapshot" = \(CASE/);
    expect(q!.sql).toContain(
      `"status" IN ('SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'BOUNCED', 'DROPPED', 'FAILED', 'SKIPPED')`,
    );
    for (const live of ["QUEUED", "SENDING", "UNCERTAIN"]) expect(q!.sql).not.toContain(`'${live}'`);
    expect(q!.sql).toContain(`"queued_at" < (statement_timestamp() AT TIME ZONE 'UTC') - $1::interval`);
    expect(q!.sql).toContain(`"context_snapshot" IS NOT NULL`);
    expect(q!.sql).toContain(`"context_snapshot" IS DISTINCT FROM (CASE`);
    expect(q!.sql).toContain(`("context_snapshot" ->> 'dispatchOwner') IS DISTINCT FROM 'networking'`);
    expect(q!.sql).toContain(
      `THEN jsonb_build_object('_certificateTemplateIds', "context_snapshot" -> '_certificateTemplateIds')`,
    );
    // A full pass has no lower bound.
    expect(q!.sql).not.toContain(`"queued_at" >=`);
    expect(q!.params).toEqual(["7776000 seconds", 1000, "7776000 seconds"]);
    // Pick skips rows another transaction holds; the outer statement re-checks.
    expect(q!.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(q!.sql).toMatch(/\) AND "status" IN/);
  });

  it("only looks at the rows that aged out within the lookback after a full pass", async () => {
    dbMock.execute.mockResolvedValue({ rowCount: 0, rows: [] });
    await runEmailSnapshotRetention({ fullPass: false });
    const [q] = rendered();
    expect(q!.sql).toContain(`"queued_at" >= (statement_timestamp() AT TIME ZONE 'UTC') - $2::interval`);
    // 90 d, then 90 + 7 d.
    expect(q!.params.slice(0, 2)).toEqual(["7776000 seconds", "8380800 seconds"]);
  });
});
