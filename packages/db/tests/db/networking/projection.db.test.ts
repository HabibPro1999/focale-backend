import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  clients,
  events,
  forms,
  registrations,
  getDb,
  networkingConfigs,
  networkingProfiles,
  syncNetworkingRegistration,
} from "../../../src";
import { NetworkingConfigSchema } from "@app/contracts";
import { dbTestsEnabled } from "../../helpers/test-env";
const ids = {
  client: randomUUID(),
  event: randomUUID(),
  form: randomUUID(),
  registration: randomUUID(),
};
const answers = { sector: "sector-option", interests: ["interest-option"] };
describe.runIf(dbTestsEnabled())("persisted networking projection", () => {
  beforeAll(async () => {
    const db = getDb();
    await db
      .insert(clients)
      .values({ id: ids.client, name: "Projection fixture" });
    await db
      .insert(events)
      .values({
        id: ids.event,
        clientId: ids.client,
        slug: ids.event,
        name: "Projection",
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000),
      });
    await db.insert(forms).values({
      id: ids.form,
      eventId: ids.event,
      name: "Form",
      schema: {
        steps: [
          {
            id: "step",
            title: "About",
            fields: [
              {
                id: "sector",
                type: "dropdown",
                options: [
                  {
                    id: "sector-option",
                    label: "Finance",
                    translations: { en: { label: "Financial services" } },
                  },
                ],
              },
              {
                id: "interests",
                type: "checkbox",
                options: [{ id: "interest-option", label: "Investment" }],
              },
            ],
          },
        ],
      },
    });
    await db
      .insert(networkingConfigs)
      .values({
        eventId: ids.event,
        config: NetworkingConfigSchema.parse({
          enabled: true,
          approvalMode: "AUTOMATIC",
          defaultLanguage: "en",
          fieldMapping: { sector: "sector", interests: "interests" },
        }),
      });
    await db
      .insert(registrations)
      .values({
        id: ids.registration,
        eventId: ids.event,
        formId: ids.form,
        email: `${ids.registration}@example.invalid`,
        formData: answers,
        priceBreakdown: {},
        paymentStatus: "PAID",
        totalAmount: 0,
      });
  });
  afterAll(async () => {
    const db = getDb();
    await db
      .delete(registrations)
      .where(eq(registrations.id, ids.registration));
    await db.delete(forms).where(eq(forms.id, ids.form));
    await db.delete(events).where(eq(events.id, ids.event));
    await db.delete(clients).where(eq(clients.id, ids.client));
  });
  it("stores readable option labels while preserving participant overrides and source answers", async () => {
    const db = getDb();
    await syncNetworkingRegistration(ids.registration);
    let [profile] = await db
      .select()
      .from(networkingProfiles)
      .where(eq(networkingProfiles.registrationId, ids.registration));
    expect(profile.sector).toBe("Financial services");
    expect(profile.interests).toEqual(["Investment"]);
    await db
      .update(networkingProfiles)
      .set({
        sector: "Participant-owned expertise",
        overrides: { sector: "Participant-owned expertise" },
      })
      .where(eq(networkingProfiles.id, profile.id));
    await syncNetworkingRegistration(ids.registration);
    [profile] = await db
      .select()
      .from(networkingProfiles)
      .where(eq(networkingProfiles.id, profile.id));
    expect(profile.sector).toBe("Participant-owned expertise");
    const [registration] = await db
      .select()
      .from(registrations)
      .where(eq(registrations.id, ids.registration));
    expect(registration.formData).toEqual(answers);
  });
});
