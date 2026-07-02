import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  buildListWhere,
  casDecrementRegisteredTx,
  casIncrementRegisteredTx,
} from "./events";
import type { DbExecutor } from "../client";

const dialect = new PgDialect();
const render = (sql: SQL) => dialect.sqlToQuery(sql).sql;

describe("events query SQL", () => {
  it("increment CAS enforces OPEN status and the capacity predicate", async () => {
    const execute = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: "e" }] });
    const exec = { execute } as unknown as DbExecutor;

    const ok = await casIncrementRegisteredTx(exec, "event-1");

    expect(ok).toBe(true);
    const sql = render(execute.mock.calls[0][0] as SQL);
    expect(sql).toContain("status = 'OPEN'");
    expect(sql).toContain("max_capacity IS NULL OR registered_count < max_capacity");
    expect(sql).toContain("registered_count = registered_count + 1");
  });

  it("increment CAS reports no-row when the guarded update misses", async () => {
    const execute = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const exec = { execute } as unknown as DbExecutor;
    expect(await casIncrementRegisteredTx(exec, "event-1")).toBe(false);
  });

  it("decrement CAS guards on registered_count > 0", async () => {
    const execute = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: "e" }] });
    const exec = { execute } as unknown as DbExecutor;

    await casDecrementRegisteredTx(exec, "event-1");

    const sql = render(execute.mock.calls[0][0] as SQL);
    expect(sql).toContain("registered_count = registered_count - 1");
    expect(sql).toContain("registered_count > 0");
  });

  it("search filter spans name, slug, description and location", () => {
    const where = buildListWhere({ page: 1, limit: 10, search: "conf" });
    const sql = render(where as SQL);
    expect(sql).toContain("name");
    expect(sql).toContain("slug");
    expect(sql).toContain("description");
    expect(sql).toContain("location");
    expect(sql.toLowerCase()).toContain("ilike");
  });

  it("no filters yields an undefined predicate", () => {
    expect(buildListWhere({ page: 1, limit: 10 })).toBeUndefined();
  });
});
