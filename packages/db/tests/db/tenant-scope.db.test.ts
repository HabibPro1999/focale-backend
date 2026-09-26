import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  certificateTemplates,
  emailTemplates,
  getAccessItemTenantScope,
  getCertificateTemplateTenantScope,
  getClientTenantScope,
  getDb,
  getEmailTemplateTenantScope,
  getEventTenantScope,
  getFormTenantScope,
  getRegistrationTenantScope,
  getSponsorshipTenantScope,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import {
  seedClient,
  seedEvent,
  seedEventAccess,
  seedForm,
  seedRegistration,
  seedSponsorship,
  seedSponsorshipBatch,
} from "../helpers/factories";

// 5.4: the route guards' scope reads, against a migrated database. Each one
// resolves resource → event → client (active flag and modules) in one query.
describe.runIf(dbTestsEnabled())("db tier: tenant scope reads (5.4)", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  async function setup() {
    const client = await seedClient({ active: false, enabledModules: ["emails", "sponsorships"] });
    const event = await seedEvent({ clientId: client.id, status: "ARCHIVED" });
    const expected = {
      event: { id: event.id, clientId: client.id, status: "ARCHIVED", slug: event.slug },
      client: { id: client.id, active: false, enabledModules: ["emails", "sponsorships"] },
    };
    return { client, event, expected };
  }

  it("event: the event and its client", async () => {
    const { event, expected } = await setup();
    await expect(getEventTenantScope(event.id)).resolves.toEqual(expected);
    await expect(getEventTenantScope("00000000-0000-4000-8000-000000000000")).resolves.toBeNull();
  });

  it("registration: through its event to the client", async () => {
    const { event, expected } = await setup();
    const registration = await seedRegistration({ eventId: event.id });
    await expect(getRegistrationTenantScope(registration.id)).resolves.toEqual({
      registration: { id: registration.id },
      ...expected,
    });
    await expect(getRegistrationTenantScope(event.id)).resolves.toBeNull();
  });

  it("sponsorship: through its event to the client", async () => {
    const { event, expected } = await setup();
    const form = await seedForm({ eventId: event.id, type: "SPONSOR" });
    const batch = await seedSponsorshipBatch({ eventId: event.id, formId: form.id });
    const sponsorship = await seedSponsorship({ batchId: batch.id, eventId: event.id });
    await expect(getSponsorshipTenantScope(sponsorship.id)).resolves.toEqual({
      sponsorship: { id: sponsorship.id },
      ...expected,
    });
    await expect(getSponsorshipTenantScope(batch.id)).resolves.toBeNull();
  });

  it("email template: with its event and client, or alone when it belongs to no event", async () => {
    const { client, event, expected } = await setup();
    const values = { clientId: client.id, subject: "Hello", content: {}, category: "MANUAL" as const };
    const [withEvent] = await getDb()
      .insert(emailTemplates)
      .values({ ...values, name: "Event template", eventId: event.id })
      .returning();
    const [clientLevel] = await getDb()
      .insert(emailTemplates)
      .values({ ...values, name: "Client template" })
      .returning();

    await expect(getEmailTemplateTenantScope(withEvent!.id)).resolves.toEqual({
      template: { id: withEvent!.id, clientId: client.id, eventId: event.id },
      ...expected,
    });
    await expect(getEmailTemplateTenantScope(clientLevel!.id)).resolves.toEqual({
      template: { id: clientLevel!.id, clientId: client.id, eventId: null },
      event: null,
      client: null,
    });
    await expect(getEmailTemplateTenantScope(event.id)).resolves.toBeNull();
  });

  it("access item: through its event to the client (5.4b)", async () => {
    const { event, expected } = await setup();
    const access = await seedEventAccess({ eventId: event.id });
    await expect(getAccessItemTenantScope(access.id)).resolves.toEqual({
      accessItem: { id: access.id },
      ...expected,
    });
    await expect(getAccessItemTenantScope(event.id)).resolves.toBeNull();
  });

  it("certificate template: through its event to the client (5.4b)", async () => {
    const { event, expected } = await setup();
    const [template] = await getDb()
      .insert(certificateTemplates)
      .values({
        eventId: event.id,
        name: "Attendance",
        templateUrl: "https://cdn.example.com/certificates/attendance.png",
        templateWidth: 1200,
        templateHeight: 850,
      })
      .returning();
    await expect(getCertificateTemplateTenantScope(template!.id)).resolves.toEqual({
      certificateTemplate: { id: template!.id },
      ...expected,
    });
    await expect(getCertificateTemplateTenantScope(event.id)).resolves.toBeNull();
  });

  it("form: its type, through its event to the client (5.4b)", async () => {
    const { event, expected } = await setup();
    const registration = await seedForm({ eventId: event.id });
    const sponsor = await seedForm({ eventId: event.id, type: "SPONSOR" });
    await expect(getFormTenantScope(registration.id)).resolves.toEqual({
      form: { id: registration.id, type: "REGISTRATION" },
      ...expected,
    });
    await expect(getFormTenantScope(sponsor.id)).resolves.toEqual({
      form: { id: sponsor.id, type: "SPONSOR" },
      ...expected,
    });
    await expect(getFormTenantScope(event.id)).resolves.toBeNull();
  });

  it("client: its active flag and modules (5.4b)", async () => {
    const { client, event, expected } = await setup();
    await expect(getClientTenantScope(client.id)).resolves.toEqual({ client: expected.client });
    await expect(getClientTenantScope(event.id)).resolves.toBeNull();
  });
});
