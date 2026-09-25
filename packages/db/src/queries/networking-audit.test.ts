import { expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { NetworkingAdminMeetingUpdateSchema, NetworkingReportActionSchema } from "@app/contracts";
import { NETWORKING_ADMIN_AUDIT_ACTIONS, listNetworkingAdminAudit } from "./networking-audit";

const dialect = new PgDialect({ casing: "snake_case" });

it("lists every organizer meeting and report action, and no participant activity", () => {
  const actions = new Set<string>(NETWORKING_ADMIN_AUDIT_ACTIONS);
  // A new admin action in the contracts fails here until it is listed (or deliberately hidden).
  for (const action of NetworkingAdminMeetingUpdateSchema.shape.action.options)
    expect(actions.has(`MEETING_${action}`)).toBe(true);
  for (const action of NetworkingReportActionSchema.shape.action.options)
    expect(actions.has(`REPORT_${action}`)).toBe(true);
  for (const participantAction of ["SWIPE_LIKE", "SWIPE_PASS", "PROFILE_VIEW", "MFA_ENABLE", "MFA_DISABLE", "MFA_REGENERATE_RECOVERY"])
    expect(actions.has(participantAction)).toBe(false);
  expect([...actions].some((action) => action.startsWith("MFA_") || action.startsWith("SWIPE_"))).toBe(false);
});

it("reads one page in SQL, newest first, filtered to the allow-list", async () => {
  const chain = (rows: unknown[]) => {
    const builder: Record<string, unknown> = {};
    for (const method of ["from", "where", "orderBy", "limit", "offset"])
      builder[method] = vi.fn(() => builder);
    builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);
    return builder;
  };
  const selects: Record<string, unknown>[] = [];
  const db = {
    select: vi.fn((fields?: unknown) => {
      const builder = chain(fields ? [{ total: 42 }] : [{ id: "a" }]);
      selects.push(builder);
      return builder;
    }),
  };
  const result = await listNetworkingAdminAudit("event", { page: 3, limit: 20 }, db as never);
  expect(result).toEqual({ items: [{ id: "a" }], total: 42 });
  const [page] = selects as Array<Record<string, ReturnType<typeof vi.fn>>>;
  expect(page.limit).toHaveBeenCalledWith(20);
  expect(page.offset).toHaveBeenCalledWith(40);
  const orderBy = (page.orderBy.mock.calls[0] as SQL[]).map((part) => dialect.sqlToQuery(part).sql);
  expect(orderBy).toEqual(['"networking_audit"."created_at" desc', '"networking_audit"."id" desc']);
  const where = dialect.sqlToQuery(page.where.mock.calls[0][0] as never);
  expect(where.sql).toContain('"networking_audit"."event_id" = $1');
  expect(where.sql).toContain('"networking_audit"."action" in (');
  expect(where.params).toEqual(["event", ...NETWORKING_ADMIN_AUDIT_ACTIONS]);
});
