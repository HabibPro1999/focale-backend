import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  createCertificateTemplate,
  getActiveImageReadyCertificateTemplatesByIds,
  getCertificateTemplateWithEvent,
  listActiveImageReadyCertificateTemplates,
  listCertificateTemplates,
} from "./certificates";
import type { DbExecutor } from "../client";

// Fake drizzle handle: every chain step returns itself; the awaited terminal
// steps (orderBy for list, limit for getOne) resolve the canned rows. No live
// DB needed — we only exercise the row mapping.
function fakeExec(rows: unknown[], leftJoins: string[] = []): DbExecutor {
  const dialect = new PgDialect({ casing: "snake_case" });
  const chain = {
    from: () => chain,
    leftJoin: (_table: unknown, on: SQL) => {
      leftJoins.push(dialect.sqlToQuery(on).sql);
      return chain;
    },
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => Promise.resolve(rows),
    limit: () => Promise.resolve(rows),
    then: (
      resolve: (value: unknown[]) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject),
  };
  return {
    select: () => chain,
    insert: () => ({
      values: () => ({ returning: () => Promise.resolve([{ id: "tmpl-1" }]) }),
    }),
  } as unknown as DbExecutor;
}

// Legacy rows predate the column default and hold NULL applicableRoles.
const nullRoleRow = {
  template: { id: "tmpl-1", name: "Legacy", applicableRoles: null },
  accessRefId: null,
  accessRefName: null,
  accessRefType: null,
  clientId: "client-1",
  status: "OPEN",
};

describe("certificate template applicableRoles coalescing", () => {
  it("list coalesces a legacy NULL applicableRoles to []", async () => {
    const result = await listCertificateTemplates("event-1", fakeExec([nullRoleRow]));
    expect(result[0].applicableRoles).toEqual([]);
  });

  it("getOne coalesces a legacy NULL applicableRoles to []", async () => {
    const result = await getCertificateTemplateWithEvent(
      "tmpl-1",
      fakeExec([nullRoleRow]),
    );
    expect(result?.applicableRoles).toEqual([]);
    expect(result?.event).toEqual({ clientId: "client-1", status: "OPEN" });
  });

  it("keeps a populated applicableRoles untouched", async () => {
    const row = {
      ...nullRoleRow,
      template: { ...nullRoleRow.template, applicableRoles: ["SPEAKER"] },
    };
    const result = await listCertificateTemplates("event-1", fakeExec([row]));
    expect(result[0].applicableRoles).toEqual(["SPEAKER"]);
  });

  it("scopes every certificate access join to the template event", async () => {
    const joins: string[] = [];
    const exec = fakeExec([nullRoleRow], joins);

    await createCertificateTemplate(
      {
        eventId: "event-1",
        name: "Template",
        applicableRoles: [],
        accessId: "access-1",
      },
      exec,
    );
    await listCertificateTemplates("event-1", exec);
    await getCertificateTemplateWithEvent("tmpl-1", exec);
    await listActiveImageReadyCertificateTemplates("event-1", exec);
    await getActiveImageReadyCertificateTemplatesByIds(
      ["tmpl-1"],
      "event-1",
      exec,
    );

    expect(joins).toHaveLength(5);
    for (const join of joins) {
      expect(join).toContain(
        '"event_access"."event_id" = "certificate_templates"."event_id"',
      );
    }
  });
});
