import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { clients, events, forms, getDb } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { loadFormConditionReport } from "./form-condition-scan";

const enabled = dbTestsEnabled();
const ids = { client: randomUUID(), event: randomUUID(), form: randomUUID() };

describe.runIf(enabled)("form condition report (real database)", () => {
  beforeAll(async () => {
    await getDb().insert(clients).values({ id: ids.client, name: "Form condition report", enabledModules: ["registrations"] });
    await getDb().insert(events).values({
      id: ids.event,
      clientId: ids.client,
      name: "Report fixture",
      slug: `report-${ids.event}`,
      startDate: new Date("2031-04-05T00:00Z"),
      endDate: new Date("2031-04-06T00:00Z"),
    });
    await getDb().insert(forms).values({
      id: ids.form,
      eventId: ids.event,
      name: "Registration",
      schema: {
        steps: [
          {
            id: "s1",
            title: "Profile",
            fields: [
              { id: "a", type: "text" },
              { id: "b", type: "text" },
              {
                id: "both",
                type: "text",
                conditionLogic: "AND",
                conditions: [
                  { id: "c1", fieldId: "a", operator: "equals", value: "1" },
                  { id: "c2", fieldId: "b", operator: "equals", value: "2" },
                ],
              },
            ],
          },
        ],
      },
    });
  });

  it("reads forms in a read-only transaction and reports uppercase logic", async () => {
    const before = await getDb().select().from(forms);

    const report = await loadFormConditionReport();

    expect(report.scanned).toBe(before.length);
    expect(report.findings.filter((f) => f.formId === ids.form)).toEqual([
      expect.objectContaining({ kind: "UPPERCASE_LOGIC", fieldId: "both", changesVisibility: true }),
    ]);
    expect(await getDb().select().from(forms)).toEqual(before);
  });
});
