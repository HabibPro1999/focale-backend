import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  certificateTemplates,
  clients,
  emailLogs,
  eventPricing,
  events,
  forms,
  getDb,
} from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { formatStoredJsonReport, loadStoredJsonReport } from "./stored-json-scan";

const enabled = dbTestsEnabled();
const ids = {
  client: randomUUID(),
  event: randomUUID(),
  validForm: randomUUID(),
  legacyForm: randomUUID(),
  pricing: randomUUID(),
  template: randomUUID(),
  validLog: randomUUID(),
  legacyLog: randomUUID(),
};
const SECRET = "registrant-secret-value";

async function snapshotRows() {
  const db = getDb();
  const ourIds = new Set<string>(Object.values(ids));
  const ours = <T extends { id: string }>(rows: T[]) => rows.filter((row) => ourIds.has(row.id));
  return {
    forms: ours(await db.select().from(forms)),
    pricing: ours(await db.select().from(eventPricing)),
    templates: ours(await db.select().from(certificateTemplates)),
    logs: ours(await db.select().from(emailLogs)),
  };
}

// The stored-JSON audit (plan 5.2) against a migrated database, both
// engines: it pages through every typed column in READ ONLY transactions,
// lists the documents JSONB_VALIDATION=enforce would refuse (ids, paths and
// codes, never values) and changes nothing.
describe.runIf(enabled)("stored JSON report (real database)", () => {
  beforeAll(async () => {
    const db = getDb();
    await db.insert(clients).values({ id: ids.client, name: "Stored JSON report", enabledModules: ["registrations"] });
    await db.insert(events).values({
      id: ids.event,
      clientId: ids.client,
      name: "Report fixture",
      slug: `stored-json-${ids.event}`,
      startDate: new Date("2031-04-05T00:00Z"),
      endDate: new Date("2031-04-06T00:00Z"),
    });
    await db.insert(forms).values([
      {
        id: ids.validForm,
        eventId: ids.event,
        name: "Registration",
        schema: { steps: [{ id: "s1", title: "Profile", fields: [{ id: "email", type: "email" }] }] },
      },
      {
        id: ids.legacyForm,
        eventId: ids.event,
        type: "SPONSOR",
        name: "Sponsor",
        schema: {
          formType: "SPONSOR",
          sponsorSteps: [{ id: "s1", title: "Lab", fields: [] }],
          beneficiaryTemplate: { fields: [], maxCount: 100 },
        } as never,
      },
    ]);
    await db.insert(eventPricing).values({
      id: ids.pricing,
      eventId: ids.event,
      rules: [{ id: randomUUID(), name: "Legacy", price: 10, conditions: [], secretNote: SECRET }] as never,
    });
    await db.insert(certificateTemplates).values({
      id: ids.template,
      eventId: ids.event,
      name: "Attendance",
      templateUrl: "",
      templateWidth: 0,
      templateHeight: 0,
      zones: [],
    });
    await db.insert(emailLogs).values([
      { id: ids.validLog, recipientEmail: "a@example.test", subject: "", contextSnapshot: { firstName: SECRET } },
      { id: ids.legacyLog, recipientEmail: "b@example.test", subject: "", contextSnapshot: [SECRET] as never },
    ]);
  });

  it("lists the invalid documents by id, path and code, reads in pages and writes nothing", async () => {
    const before = await snapshotRows();

    const report = await loadStoredJsonReport({ batchSize: 1 });

    const findingsFor = (column: string, id: string) =>
      report.columns.find((c) => c.column === column)?.findings.filter((f) => f.id === id);
    expect(findingsFor("forms.schema", ids.validForm)).toEqual([]);
    expect(findingsFor("forms.schema", ids.legacyForm)).toEqual([
      {
        column: "forms.schema",
        id: ids.legacyForm,
        issues: [{ path: "beneficiaryTemplate.minCount", code: "missing_default" }],
      },
    ]);
    expect(findingsFor("event_pricing.rules", ids.pricing)?.[0]?.issues).toEqual(
      expect.arrayContaining([
        { path: "[0].conditions", code: "too_small" },
        { path: "[0].secretNote", code: "unrecognized_keys" },
      ]),
    );
    expect(findingsFor("certificate_templates.zones", ids.template)).toEqual([]);
    expect(findingsFor("email_logs.context_snapshot", ids.validLog)).toEqual([]);
    expect(findingsFor("email_logs.context_snapshot", ids.legacyLog)).toEqual([
      { column: "email_logs.context_snapshot", id: ids.legacyLog, issues: [{ path: "(root)", code: "invalid_type" }] },
    ]);
    for (const column of report.columns) expect(column.scanned).toBeGreaterThan(0);

    expect(formatStoredJsonReport(report).join("\n")).not.toContain(SECRET);
    expect(await snapshotRows()).toEqual(before);
  });
});
