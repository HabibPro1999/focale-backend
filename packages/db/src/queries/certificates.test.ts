import { describe, expect, it } from "vitest";
import {
  getCertificateTemplateWithEvent,
  listCertificateTemplates,
} from "./certificates";
import type { DbExecutor } from "../client";

// Fake drizzle handle: every chain step returns itself; the awaited terminal
// steps (orderBy for list, limit for getOne) resolve the canned rows. No live
// DB needed — we only exercise the row mapping.
function fakeExec(rows: unknown[]): DbExecutor {
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => Promise.resolve(rows),
    limit: () => Promise.resolve(rows),
  };
  return { select: () => chain } as unknown as DbExecutor;
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
});
