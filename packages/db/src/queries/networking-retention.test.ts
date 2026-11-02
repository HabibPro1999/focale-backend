import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName, is, type SQL } from "drizzle-orm";
import { PgDialect, PgTable, getTableConfig } from "drizzle-orm/pg-core";
const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  enqueue: vi.fn(),
  txSelect: vi.fn(),
  txDelete: vi.fn(),
  order: [] as string[],
}));
vi.mock("../client", () => ({ getDb: () => ({ execute: mocks.execute }) }));
vi.mock("../txn", () => ({
  withSerializableTxn: (run: (tx: unknown) => Promise<unknown>) => run({
    select: () => ({ from: () => ({ where: () => ({ limit: mocks.txSelect }) }) }),
    delete: () => ({ where: mocks.txDelete }),
  }),
}));
vi.mock("./storage-delete", () => ({ enqueueNetworkingPhotoDeletes: mocks.enqueue }));
import * as schema from "../schema";
import {
  NETWORKING_PURGE_KEPT_TABLES,
  NETWORKING_PURGE_STEPS,
  networkingRetentionEnded,
  purgeNetworkingEvent,
} from "./networking-retention";

const dialect = new PgDialect({ casing: "snake_case" });
const text = (query: SQL) => dialect.sqlToQuery(query);
const executed = () => mocks.execute.mock.calls.map(([query]) => text(query));
const schemaTables = (Object.values(schema) as unknown[]).filter((value): value is PgTable => is(value, PgTable));
const networkingTables = schemaTables.filter((table) => getTableName(table).startsWith("networking_"));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.order = [];
  mocks.execute.mockResolvedValue({ rows: [], rowCount: 0 });
  mocks.txSelect.mockResolvedValue([]);
});

describe("purge coverage, derived from the Drizzle schema", () => {
  it("purges or deliberately keeps every networking table, plus the networking email logs", () => {
    expect(networkingTables.length).toBeGreaterThanOrEqual(20);
    const covered = new Set([...NETWORKING_PURGE_STEPS.map((step) => step.table), ...NETWORKING_PURGE_KEPT_TABLES]);
    // A new networking table fails here until the purge covers it (or keeps it on purpose).
    expect(networkingTables.filter((table) => !covered.has(table)).map(getTableName)).toEqual([]);
    expect(NETWORKING_PURGE_KEPT_TABLES.map(getTableName)).toEqual(["networking_configs"]);
    expect(NETWORKING_PURGE_STEPS.map((step) => step.name)).toContain("email_logs");
    expect(new Set(NETWORKING_PURGE_STEPS.map((step) => step.name)).size).toBe(NETWORKING_PURGE_STEPS.length);
  });

  it("deletes every referencing table before the table it references, so no batch cascades or hits a restrict", () => {
    const position = new Map(NETWORKING_PURGE_STEPS.map((step, index) => [step.table, index]));
    const violations: string[] = [];
    for (const step of NETWORKING_PURGE_STEPS)
      for (const foreignKey of getTableConfig(step.table).foreignKeys) {
        const target = foreignKey.reference().foreignTable;
        const targetIndex = position.get(target);
        if (targetIndex !== undefined && targetIndex <= position.get(step.table)! && target !== step.table)
          violations.push(`${step.name} → ${getTableName(target)}`);
      }
    expect(violations).toEqual([]);
  });
});

describe("purgeNetworkingEvent", () => {
  it("disables the config first, drains each table in bounded batches and stamps purged_at last", async () => {
    let reservations = 0;
    mocks.execute.mockImplementation(async (query: SQL) => {
      const { sql } = text(query);
      if (sql.includes('DELETE FROM "networking_reservations"')) return { rowCount: [2, 1][reservations++] ?? 0 };
      return { rowCount: 0, rows: [] };
    });
    const batches: Array<[string, number]> = [];
    const result = await purgeNetworkingEvent("event", { batchSize: 2, onBatch: (table, count) => batches.push([table, count]) });
    expect(result).toEqual({ eventId: "event", done: true, deleted: { networking_reservations: 3 } });

    const queries = executed();
    expect(queries[0].sql).toContain("jsonb_set(config,'{enabled}','false'::jsonb)");
    expect(queries[0].sql).toContain("purge_started_at=COALESCE(purge_started_at,now())");
    expect(queries.at(-1)!.sql).toContain("SET purged_at=now()");
    // Two reservation batches (a full one, then a short one), then one batch per other step.
    expect(batches.slice(0, 3)).toEqual([["networking_reservations", 2], ["networking_reservations", 1], ["networking_meetings", 0]]);
    expect(batches.map(([table]) => table)).toEqual([
      "networking_reservations", ...NETWORKING_PURGE_STEPS.map((step) => step.name),
    ]);
    const deletes = queries.filter((query) => query.sql.trim().startsWith("DELETE"));
    for (const query of deletes) {
      expect(query.sql).toMatch(/LIMIT \$\d+/);
      expect(query.params).toContain("event");
    }
    const audit = deletes.find((query) => query.sql.includes('DELETE FROM "networking_audit"'))!;
    expect(audit.sql).toContain('"networking_audit"."action" NOT IN ($');
    expect(audit.params).toContain("POST_EVENT_REPORT");
    const emails = deletes.find((query) => query.sql.includes('DELETE FROM "email_logs"'))!;
    expect(emails.sql).toContain(`("email_logs"."context_snapshot" ->> 'dispatchOwner') = 'networking'`);
    expect(emails.sql).toContain(`("email_logs"."context_snapshot" ->> 'eventId') = $`);
    const locks = deletes.find((query) => query.sql.includes('DELETE FROM "networking_allocation_locks"'))!;
    // Composite key: the outer delete stays scoped to the event.
    expect(locks.sql).toMatch(/DELETE FROM "networking_allocation_locks" WHERE "networking_allocation_locks"."event_id"=\$1 AND/);
  });

  it("queues each purged profile's photo in the transaction that deletes the profile", async () => {
    const batch = [
      { id: "p", eventId: "event", photoUrl: "https://cdn.test/networking/event/profiles/p/a.webp" },
      { id: "q", eventId: "event", photoUrl: null },
    ];
    mocks.txSelect.mockResolvedValueOnce(batch).mockResolvedValue([]);
    mocks.enqueue.mockImplementation(async () => { mocks.order.push("enqueue"); });
    mocks.txDelete.mockImplementation(async () => { mocks.order.push("delete"); });
    const result = await purgeNetworkingEvent("event", { batchSize: 2 });
    expect(result.deleted.networking_profiles).toBe(2);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.anything(), batch, "networking.retention");
    expect(mocks.order).toEqual(["enqueue", "delete"]);
  });

  it("stops at the deadline without stamping purged_at, so the next run resumes", async () => {
    const result = await purgeNetworkingEvent("event", { deadline: Date.now() - 1 });
    expect(result).toEqual({ eventId: "event", done: false, deleted: {} });
    const queries = executed();
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("purge_started_at=COALESCE(purge_started_at,now())");
    expect(queries[0].sql).toContain("AND (purge_started_at IS NULL OR config->>'enabled'='true')");
  });
});

it("retention ends strictly after endDate + retentionDays", () => {
  const end = new Date("2030-01-01T00:00:00Z");
  const limit = end.getTime() + 90 * 86_400_000;
  expect(networkingRetentionEnded(end, 90, limit)).toBe(false);
  expect(networkingRetentionEnded(end, 90, limit + 1)).toBe(true);
});
