import { describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

vi.mock("../client", () => ({ getDb: () => undefined }));

import type { DbExecutor } from "../client";
import { EMAIL_LOG_LIST_COUNT_CAP, listEventEmailLogs } from "./email";

// 3.6b: the event email-log list is two index-backed branches (by
// registration, by template) glued with UNION ALL, plus a capped count. The
// real drizzle builders render the SQL; awaiting one resolves canned rows.

const mockDb = drizzle.mock({ casing: "snake_case" });
const dialect = new PgDialect({ casing: "snake_case" });

interface Canned {
  /** Rows of the UNION ALL page query (ids in page order). */
  page: Array<{ id: string; queuedAt: Date }>;
  /** Rows of the load-by-id query. */
  rows: Array<{ log: Record<string, unknown>; templateName: string | null }>;
  count: number | string;
}

function makeExec(canned: Canned) {
  const selects: Array<{ sql: string; params: unknown[] }> = [];
  const executes: Array<{ sql: string; params: unknown[] }> = [];
  const select = (fields: never) => {
    const builder = mockDb.select(fields);
    const from = builder.from.bind(builder);
    builder.from = ((table: never) => {
      const query = from(table);
      Object.assign(query, {
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
          const rendered = query.toSQL();
          selects.push(rendered);
          const result = /union all/i.test(rendered.sql) ? canned.page : canned.rows;
          return Promise.resolve(result).then(resolve, reject);
        },
      });
      return query;
    }) as typeof builder.from;
    return builder;
  };
  const execute = vi.fn(async (query: SQL) => {
    executes.push(dialect.sqlToQuery(query));
    return { rows: [{ n: canned.count }] };
  });
  return { exec: { select, execute } as unknown as DbExecutor, selects, executes };
}

function logRow(id: string, queuedAt: string) {
  return {
    log: {
      id,
      subject: `S ${id}`,
      status: "SENT",
      trigger: null,
      recipientEmail: `${id}@x.test`,
      recipientName: null,
      errorMessage: null,
      queuedAt: new Date(queuedAt),
      sentAt: null,
      deliveredAt: null,
      openedAt: null,
      clickedAt: null,
      bouncedAt: null,
      failedAt: null,
    },
    templateName: id === "b" ? "Welcome" : null,
  };
}

describe("listEventEmailLogs (3.6b)", () => {
  it("unions two index-backed branches, each cut to skip + limit rows, then pages", async () => {
    const { exec, selects } = makeExec({ page: [], rows: [], count: 0 });
    await listEventEmailLogs("event-1", { skip: 40, limit: 20 }, exec);

    const page = selects.find((q) => /union all/i.test(q.sql))!;
    const [byRegistration, byTemplate] = page.sql.split(/\) union all \(/i);
    // Branch 1: the event's registrations' emails.
    expect(byRegistration).toContain(
      `"email_logs"."registration_id" in (select "id" from "registrations" where "registrations"."event_id" = $1)`,
    );
    expect(byRegistration).not.toContain(`"email_logs"."template_id" in`);
    // Branch 2: the event's templates' emails, minus the rows of branch 1.
    expect(byTemplate).toContain(
      `"email_logs"."template_id" in (select "id" from "email_templates" where "email_templates"."event_id" = $`,
    );
    expect(byTemplate).toMatch(
      /"email_logs"\."registration_id" is null or not exists \(select 1 from "registrations" where \("registrations"\."id" = "email_logs"\."registration_id" and "registrations"\."event_id" = \$\d+\)\)/,
    );
    // Each branch: newest first, cut to skip + limit (60).
    for (const branch of [byRegistration, byTemplate]) {
      expect(branch).toContain(`order by "email_logs"."queued_at" desc, "email_logs"."id" desc limit $`);
    }
    expect(page.params.filter((p) => p === 60)).toHaveLength(2);
    // The union is ordered the same way, then paged.
    expect(page.sql).toMatch(/\) order by "queued_at" DESC, "id" DESC\s+limit \$\d+ offset \$\d+$/);
    expect(page.params.slice(-2)).toEqual([20, 40]);
    expect(page.params.filter((p) => p === "event-1")).toHaveLength(3);
  });

  it("applies the status and trigger filters in both branches", async () => {
    const { exec, selects, executes } = makeExec({ page: [], rows: [], count: 0 });
    await listEventEmailLogs("event-1", { skip: 0, limit: 50, status: "UNCERTAIN", trigger: "PAYMENT_CONFIRMED" }, exec);

    const page = selects.find((q) => /union all/i.test(q.sql))!;
    for (const branch of page.sql.split(/\) union all \(/i)) {
      expect(branch).toContain(`"email_logs"."status" = $`);
      expect(branch).toContain(`"email_logs"."trigger" = $`);
    }
    expect(page.params.filter((p) => p === "UNCERTAIN")).toHaveLength(2);
    // No offset for the first page.
    expect(page.sql).not.toMatch(/offset/i);

    const [count] = executes;
    expect(count!.params.filter((p) => p === "UNCERTAIN")).toHaveLength(2);
  });

  it("counts each branch up to the cap + 1 and reports a capped total", async () => {
    const { exec, executes } = makeExec({ page: [], rows: [], count: "10002" });
    const result = await listEventEmailLogs("event-1", { skip: 0, limit: 50 }, exec);

    const [count] = executes;
    // The derived table is the parenthesized UNION ALL of the two capped branches.
    expect(count!.sql).toMatch(/select count\(\*\) as "n"\s+from \(\(select "id" from "email_logs"/i);
    expect(count!.sql).toMatch(/limit \$\d+\)\) as "capped"/i);
    expect(count!.sql).toMatch(/\) union all \(/i);
    expect(count!.params.filter((p) => p === EMAIL_LOG_LIST_COUNT_CAP + 1)).toHaveLength(2);
    expect(result).toMatchObject({ total: EMAIL_LOG_LIST_COUNT_CAP, totalCapped: true });
  });

  it("returns the exact total under the cap", async () => {
    const { exec } = makeExec({ page: [], rows: [], count: 7 });
    await expect(listEventEmailLogs("event-1", { skip: 0, limit: 50, countCap: 7 }, exec)).resolves.toMatchObject({
      total: 7,
      totalCapped: false,
    });
    const capped = makeExec({ page: [], rows: [], count: 8 });
    await expect(listEventEmailLogs("event-1", { skip: 0, limit: 50, countCap: 7 }, capped.exec)).resolves.toMatchObject({
      total: 7,
      totalCapped: true,
    });
  });

  it("loads only the page's rows and keeps the page order", async () => {
    const { exec, selects } = makeExec({
      page: [
        { id: "b", queuedAt: new Date("2026-09-02T00:00:00Z") },
        { id: "a", queuedAt: new Date("2026-09-01T00:00:00Z") },
        { id: "gone", queuedAt: new Date("2026-08-01T00:00:00Z") },
      ],
      rows: [logRow("a", "2026-09-01T00:00:00Z"), logRow("b", "2026-09-02T00:00:00Z")],
      count: 3,
    });
    const result = await listEventEmailLogs("event-1", { skip: 0, limit: 3 }, exec);

    const load = selects.find((q) => !/union all/i.test(q.sql))!;
    expect(load.sql).toContain(`left join "email_templates" on "email_templates"."id" = "email_logs"."template_id"`);
    expect(load.sql).toContain(`where "email_logs"."id" in ($1, $2, $3)`);
    expect(result.data.map((row) => row.id)).toEqual(["b", "a"]);
    expect(result.data[0]).toMatchObject({ templateName: "Welcome", queuedAt: "2026-09-02T00:00:00.000Z", sentAt: null });
    expect(result.total).toBe(3);
  });

  it("skips the row load for an empty page", async () => {
    const { exec, selects } = makeExec({ page: [], rows: [], count: 0 });
    await expect(listEventEmailLogs("event-1", { skip: 0, limit: 50 }, exec)).resolves.toEqual({
      data: [],
      total: 0,
      totalCapped: false,
    });
    expect(selects).toHaveLength(1);
  });
});
