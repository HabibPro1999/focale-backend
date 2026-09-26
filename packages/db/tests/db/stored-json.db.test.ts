import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  StoredJsonError,
  certificateTemplates,
  configureJsonbValidation,
  emailLogs,
  eventPricing,
  findFormById,
  getAlreadySentCertTemplateIds,
  getDb,
  getEventPricing,
  getEventWithPricing,
  listCertificateTemplates,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent, seedForm, seedRegistration } from "../helpers/factories";

// Typed JSONB read boundaries (plan 5.2) on a migrated database, both
// engines. Documents that are not what their column type says (legacy rows,
// hand edits) are read exactly as stored under JSONB_VALIDATION=warn (as
// before typing) and refused under enforce; valid documents pass either way.
describe.runIf(dbTestsEnabled())("db: typed JSONB read boundaries", () => {
  beforeEach(cleanupDatabase);
  afterEach(async () => {
    configureJsonbValidation(undefined);
    await cleanupDatabase();
  });

  const zone = {
    id: "z1",
    x: 10,
    y: 20,
    width: 50,
    height: 10,
    variable: "fullName",
    fontSize: null,
    fontWeight: "bold",
    color: "#000000",
    textAlign: "center",
  } as const;
  const rule = {
    id: "8c0f5d8e-4b8a-4e0b-9a55-2f1f6c1e7a10",
    name: "Members",
    description: null,
    priority: 0,
    conditions: [{ fieldId: "membership", operator: "equals", value: "member" }],
    conditionLogic: "AND",
    price: 150,
    active: true,
  } as const;
  const validForm = { steps: [{ id: "s1", title: "Profile", fields: [{ id: "email", type: "email" }] }] } as const;

  // One invalid document per typed column.
  const legacyRules = [{ ...rule, legacyDiscount: 10 }];
  const legacyZones = [{ id: "z1", x: 10, y: 20, width: 50, height: 10, variable: "fullName", fontSize: null }];
  const legacyForm = { fields: [{ id: "email", type: "email" }] };
  const legacySnapshot = { _certificateTemplateIds: "cert-a" };

  async function seed(documents: "valid" | "legacy") {
    const legacy = documents === "legacy";
    const event = await seedEvent();
    const form = await seedForm({
      eventId: event.id,
      schema: (legacy ? legacyForm : validForm) as never,
    });
    await getDb()
      .insert(eventPricing)
      .values({ eventId: event.id, rules: (legacy ? legacyRules : [rule]) as never });
    await getDb().insert(certificateTemplates).values({
      eventId: event.id,
      name: "Attendance",
      templateUrl: "https://cdn.example/cert.png",
      templateWidth: 2000,
      templateHeight: 1400,
      zones: (legacy ? legacyZones : [zone]) as never,
    });
    const registration = await seedRegistration({ eventId: event.id, formId: form.id });
    await getDb().insert(emailLogs).values({
      registrationId: registration.id,
      trigger: "CERTIFICATE_SENT",
      recipientEmail: registration.email,
      subject: "",
      status: "SENT",
      contextSnapshot: (legacy ? legacySnapshot : { _certificateTemplateIds: ["cert-a"] }) as never,
    });
    return { event, form, registration };
  }

  it.each(["warn", "enforce"] as const)("reads valid documents under %s", async (mode) => {
    configureJsonbValidation(mode);
    const { event, form, registration } = await seed("valid");

    expect((await getEventPricing(event.id))?.rules).toEqual([rule]);
    expect((await getEventWithPricing(event.id))?.pricing?.rules).toEqual([rule]);
    expect((await findFormById(form.id))?.schema).toEqual(validForm);
    expect((await listCertificateTemplates(event.id)).map((t) => t.zones)).toEqual([[zone]]);
    expect(await getAlreadySentCertTemplateIds([registration.id])).toEqual(
      new Map([[registration.id, new Set(["cert-a"])]]),
    );
  });

  it("warn: reads invalid documents exactly as stored, as before typing", async () => {
    configureJsonbValidation("warn");
    const { event, form, registration } = await seed("legacy");

    expect((await getEventPricing(event.id))?.rules).toEqual(legacyRules);
    expect((await getEventWithPricing(event.id))?.pricing?.rules).toEqual(legacyRules);
    expect((await findFormById(form.id))?.schema).toEqual(legacyForm);
    expect((await listCertificateTemplates(event.id)).map((t) => t.zones)).toEqual([legacyZones]);
    // A non-array id list is skipped, as before.
    expect(await getAlreadySentCertTemplateIds([registration.id])).toEqual(new Map());
  });

  it("enforce: refuses invalid documents, naming the column, row and paths", async () => {
    configureJsonbValidation("enforce");
    const { event, form, registration } = await seed("legacy");

    await expect(getEventPricing(event.id)).rejects.toThrow(StoredJsonError);
    await expect(getEventPricing(event.id)).rejects.toThrow(
      "event_pricing.rules (id ",
    );
    await expect(getEventWithPricing(event.id)).rejects.toThrow("[0].legacyDiscount (unrecognized_keys)");
    await expect(findFormById(form.id)).rejects.toThrow(
      `Stored JSON forms.schema (id ${form.id}) does not match its schema: steps (invalid_type)`,
    );
    await expect(listCertificateTemplates(event.id)).rejects.toThrow(
      "[0].fontWeight (missing_default), [0].color (missing_default), [0].textAlign (missing_default)",
    );
    await expect(getAlreadySentCertTemplateIds([registration.id])).rejects.toThrow(
      "email_logs.context_snapshot",
    );
  });
});
