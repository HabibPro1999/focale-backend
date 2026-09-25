import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  CERTIFICATE_EMAIL_SENT_STATUSES,
  planCertificateEmailLogs,
  queueCertificateEmailLogsTxn,
  type CertificateEmailCandidate,
  type PlannedCertificateEmail,
  createCertificateTemplate,
  getActiveImageReadyCertificateTemplatesByIds,
  getCertificateTemplateWithEvent,
  listActiveImageReadyCertificateTemplates,
  listCertificateTemplates,
} from "./certificates";
import type { DbExecutor } from "../client";
import { emailStatus } from "../schema/enums";

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

describe("certificate send planning (2.12)", () => {
  const certA = { id: "cert-a", name: "Attendance" };
  const certB = { id: "cert-b", name: "Presenter" };

  function candidate(
    targetId: string,
    overrides: Partial<CertificateEmailCandidate> = {},
  ): CertificateEmailCandidate {
    return {
      targetId,
      recipientEmail: "ada@example.com",
      recipientName: "Ada Lovelace",
      certificates: [certA, certB],
      contextSnapshot: { fullName: "Ada Lovelace" },
      ...overrides,
    };
  }

  const input = (
    registrations: CertificateEmailCandidate[],
    abstracts: CertificateEmailCandidate[] = [],
  ) => ({ eventId: "event-1", emailTemplateId: "et-1", registrations, abstracts });

  function inserted(planned: PlannedCertificateEmail) {
    if (planned.status !== "insert") throw new Error(`expected a row, got ${planned.status}`);
    return planned;
  }

  it("counts OPENED, CLICKED and UNCERTAIN certificate emails as already sent", () => {
    expect(CERTIFICATE_EMAIL_SENT_STATUSES).toEqual(
      expect.arrayContaining(["QUEUED", "SENDING", "SENT", "DELIVERED", "OPENED", "CLICKED", "UNCERTAIN"]),
    );
    for (const retryable of ["BOUNCED", "DROPPED", "FAILED", "SKIPPED"]) {
      expect(CERTIFICATE_EMAIL_SENT_STATUSES).not.toContain(retryable);
    }
  });

  it("classifies every email status as sent or resendable", () => {
    // A status added to the enum later must be placed on one side on purpose.
    const resendable = ["BOUNCED", "DROPPED", "FAILED", "SKIPPED"];
    expect([...CERTIFICATE_EMAIL_SENT_STATUSES, ...resendable].sort()).toEqual(
      [...emailStatus.enumValues].sort(),
    );
  });

  it("queues only the certificates a registration does not have yet", () => {
    const plan = planCertificateEmailLogs(
      input([candidate("reg-1")]),
      new Map([["reg-1", new Set(["cert-a"])]]),
      new Map(),
    );
    const { row, certificates } = inserted(plan.registrations[0]);
    expect(certificates).toEqual([certB]);
    expect(row).toMatchObject({
      trigger: "CERTIFICATE_SENT",
      templateId: "et-1",
      registrationId: "reg-1",
      recipientEmail: "ada@example.com",
      recipientName: "Ada Lovelace",
      subject: "",
      status: "QUEUED",
      contextSnapshot: {
        fullName: "Ada Lovelace",
        certificateCount: "1",
        certificateList: "Presenter",
        _certificateTemplateIds: ["cert-b"],
      },
    });
    expect(row).not.toHaveProperty("abstractId");
  });

  it("reports already_sent when every eligible certificate is covered", () => {
    const plan = planCertificateEmailLogs(
      input([candidate("reg-1")]),
      new Map([["reg-1", new Set(["cert-a", "cert-b"])]]),
      new Map(),
    );
    expect(plan.registrations).toEqual([{ status: "already_sent" }]);
  });

  it("dedupes abstracts against the abstract map, not the registration map", () => {
    const plan = planCertificateEmailLogs(
      input([candidate("shared-id")], [candidate("shared-id")]),
      new Map([["shared-id", new Set(["cert-a", "cert-b"])]]),
      new Map(),
    );
    expect(plan.registrations).toEqual([{ status: "already_sent" }]);
    const { row } = inserted(plan.abstracts[0]);
    expect(row).toMatchObject({ abstractId: "shared-id" });
    expect(row).not.toHaveProperty("registrationId");
  });

  it("gives an author with two abstracts one email per abstract", () => {
    const plan = planCertificateEmailLogs(
      input([], [candidate("abs-1"), candidate("abs-2")]),
      new Map(),
      new Map(),
    );
    const rows = plan.abstracts.map((p) => inserted(p).row);
    expect(rows.map((r) => r.abstractId)).toEqual(["abs-1", "abs-2"]);
    expect(rows.map((r) => r.recipientEmail)).toEqual(["ada@example.com", "ada@example.com"]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });

  it("queues a target listed twice in one call once", () => {
    const plan = planCertificateEmailLogs(
      input([candidate("reg-1"), candidate("reg-1")]),
      new Map(),
      new Map(),
    );
    expect(inserted(plan.registrations[0]).certificates).toEqual([certA, certB]);
    expect(plan.registrations[1]).toEqual({ status: "already_sent" });
  });

  it("does not mutate the caller's already-sent sets", () => {
    const sent = new Set(["cert-a"]);
    planCertificateEmailLogs(input([candidate("reg-1")]), new Map([["reg-1", sent]]), new Map());
    expect([...sent]).toEqual(["cert-a"]);
  });

  it("opens no transaction when there is nothing to queue", async () => {
    await expect(queueCertificateEmailLogsTxn(input([]))).resolves.toEqual({
      registrations: [],
      abstracts: [],
    });
  });
});
