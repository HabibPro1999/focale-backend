import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ListSponsorshipsQuerySchema, type PriceBreakdown } from "@app/contracts";
import { getSkip } from "@app/shared";
import {
  findEventForBatch,
  findRegistrationForLink,
  findRegistrationsForBatch,
  findSponsorFormById,
  findSponsorshipForLink,
  findSponsorshipForMutation,
  getActiveSponsorForm,
  getDb,
  getFormSchema,
  getLinkedSponsorships,
  getPendingSponsorships,
  getRegistrationCoverage,
  getRegistrationForSponsorship,
  getSponsorshipByCode,
  getSponsorshipById,
  listSponsorships,
  registrations,
  searchRegistrantsForSponsorship,
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
  seedSponsorshipUsage,
} from "../helpers/factories";

// Characterize the current query result boundary before any file split or
// nested-select change. Whole-row sponsorship reads preserve nullable arrays;
// coverage/search projections normalize them. Missing joined registrations
// stay null without dropping the usage. Unordered relation arrays are compared
// by identity, so the tests do not invent an SQL order the queries do not have.

function breakdown(accessId: string): PriceBreakdown {
  return {
    basePrice: 400,
    calculatedBasePrice: 400,
    appliedRules: [],
    accessItems: [{ accessId, name: "Workshop", unitPrice: 100, quantity: 1, subtotal: 100 }],
    accessTotal: 100,
    subtotal: 500,
    sponsorships: [],
    sponsorshipTotal: 200,
    total: 300,
    currency: "TND",
    droppedAccessItems: [],
  };
}

async function fixture() {
  const client = await seedClient({ name: "Mapping organizer", active: false, enabledModules: null });
  const event = await seedEvent({
    clientId: client.id,
    name: "Mapping event",
    status: "ARCHIVED",
    location: null,
  });
  const form = await seedForm({
    eventId: event.id,
    schema: { steps: [{ id: "registration", title: "Registration", fields: [] }] },
  });
  const sponsorSchema = {
    formType: "SPONSOR" as const,
    sponsorSteps: [{ id: "sponsor", title: "Sponsor", fields: [] }],
    beneficiaryTemplate: { fields: [], minCount: 1, maxCount: 100 },
    sponsorshipSettings: { sponsorshipMode: "LINKED_ACCOUNT" as const, autoApproveSponsorship: true },
  };
  const sponsorForm = await seedForm({ eventId: event.id, type: "SPONSOR", schema: sponsorSchema });
  const batch = await seedSponsorshipBatch({
    eventId: event.id,
    formId: sponsorForm.id,
    labName: "Mapping lab",
    contactName: "Mapping contact",
    email: "lab-mapping@example.test",
    phone: null,
    formData: { department: "Research" },
  });
  const access = await seedEventAccess({ eventId: event.id, name: "Workshop", price: 100 });
  const used = await seedSponsorship({
    eventId: event.id,
    batchId: batch.id,
    beneficiaryName: "A used",
    beneficiaryEmail: "used-mapping@example.test",
    status: "USED",
    totalAmount: 200,
    coversBasePrice: true,
    coveredAccessIds: [access.id],
    createdAt: new Date("2028-01-01T00:00:00.000Z"),
  });
  const pending = await seedSponsorship({
    eventId: event.id,
    batchId: batch.id,
    beneficiaryName: "B pending",
    status: "PENDING",
    totalAmount: 90,
    coversBasePrice: false,
    coveredAccessIds: null,
    createdAt: new Date("2028-01-02T00:00:00.000Z"),
  });
  const cancelled = await seedSponsorship({
    eventId: event.id,
    batchId: batch.id,
    beneficiaryName: "C cancelled",
    status: "CANCELLED",
    totalAmount: 40,
    coversBasePrice: false,
    coveredAccessIds: [],
    createdAt: new Date("2028-01-03T00:00:00.000Z"),
  });
  const registration = await seedRegistration({
    eventId: event.id,
    formId: form.id,
    email: "alice-mapping@example.test",
    firstName: "MappingAlice",
    lastName: null,
    phone: "+21612345678",
    totalAmount: 500,
    baseAmount: 400,
    accessAmount: 100,
    paidAmount: 0,
    sponsorshipAmount: 200,
    paymentStatus: "PARTIAL",
    accessTypeIds: null,
    priceBreakdown: breakdown(access.id),
    linkBaseUrl: null,
    editToken: null,
  });
  const other = await seedRegistration({
    eventId: event.id,
    formId: form.id,
    email: "deleted-mapping@example.test",
    firstName: null,
    lastName: "MappingDeleted",
    totalAmount: 500,
    baseAmount: 400,
    accessAmount: 100,
    sponsorshipAmount: 200,
    paymentStatus: "PARTIAL",
    priceBreakdown: breakdown(access.id),
  });
  const usage = await seedSponsorshipUsage({ sponsorshipId: used.id, registrationId: registration.id, amountApplied: 200, appliedBy: "mapping-test" });
  const otherUsage = await seedSponsorshipUsage({ sponsorshipId: used.id, registrationId: other.id, amountApplied: 200, appliedBy: "mapping-test" });
  return { client, event, form, sponsorForm, sponsorSchema, batch, access, used, pending, cancelled, registration, other, usage, otherUsage };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function batchSummary(f: Fixture) {
  return { id: f.batch.id, labName: f.batch.labName, contactName: f.batch.contactName, email: f.batch.email };
}

function registrationForBatch(f: Fixture) {
  const r = f.registration;
  return {
    id: r.id,
    email: r.email,
    firstName: r.firstName,
    lastName: r.lastName,
    phone: r.phone,
    totalAmount: r.totalAmount,
    sponsorshipAmount: r.sponsorshipAmount,
    baseAmount: r.baseAmount,
    accessTypeIds: [],
    priceBreakdown: breakdown(f.access.id),
    paymentStatus: r.paymentStatus,
    linkBaseUrl: null,
    editToken: null,
  };
}

/** The service's list arguments: parsed query plus its page offset. */
function listQuery(input: unknown) {
  const query = ListSponsorshipsQuerySchema.parse(input);
  return { ...query, offset: getSkip(query) };
}

describe.runIf(dbTestsEnabled())("sponsorship read mapping characterization", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it("list rebuilds batch/usage groups, preserves raw null coverage and keeps filtered stats separate from pagination", async () => {
    const f = await fixture();
    const result = await listSponsorships(f.event.id, listQuery({
      page: 1, limit: 2, sortBy: "beneficiaryName", sortOrder: "asc",
    }));
    expect(result.data).toEqual([
      {
        ...f.used,
        batch: batchSummary(f),
        usages: expect.arrayContaining([
          { registrationId: f.registration.id, amountApplied: 200 },
          { registrationId: f.other.id, amountApplied: 200 },
        ]),
      },
      { ...f.pending, coveredAccessIds: null, batch: batchSummary(f), usages: [] },
    ]);
    expect(result.data[0].usages).toHaveLength(2);
    expect(result.total).toBe(3);
    expect(result.stats).toEqual({
      total: 3, totalAmount: 330,
      pending: { count: 1, amount: 90 },
      used: { count: 1, amount: 200 },
      cancelled: { count: 1, amount: 40 },
    });
    const filtered = await listSponsorships(f.event.id, listQuery({ status: "PENDING" }));
    expect(filtered.data).toEqual([{ ...f.pending, batch: batchSummary(f), usages: [] }]);
    expect(filtered.stats).toEqual({
      total: 1, totalAmount: 90,
      pending: { count: 1, amount: 90 },
      used: { count: 0, amount: 0 },
      cancelled: { count: 0, amount: 0 },
    });
  });

  it("detail keeps a deleted registration's usage with a null joined registration", async () => {
    const f = await fixture();
    const before = await getSponsorshipById(f.used.id);
    expect(before).toEqual({
      ...f.used,
      event: { clientId: f.client.id },
      batch: f.batch,
      usages: expect.arrayContaining([
        { ...f.usage, registration: { id: f.registration.id, email: f.registration.email, firstName: "MappingAlice", lastName: null } },
        { ...f.otherUsage, registration: { id: f.other.id, email: f.other.email, firstName: null, lastName: "MappingDeleted" } },
      ]),
      coveredAccessItems: [{ id: f.access.id, name: "Workshop", price: 100 }],
    });
    expect(before?.usages).toHaveLength(2);
    await getDb().delete(registrations).where(eq(registrations.id, f.other.id));
    const after = await getSponsorshipById(f.used.id);
    expect(after?.usages).toHaveLength(2);
    expect(after?.usages.find((usage) => usage.id === f.otherUsage.id)).toEqual({
      ...f.otherUsage, registrationId: null, registration: null,
    });
    expect(after?.usages.find((usage) => usage.id === f.usage.id)).toEqual(before?.usages.find((usage) => usage.id === f.usage.id));
    expect(after?.coveredAccessItems).toEqual(before?.coveredAccessItems);
    const mutation = await findSponsorshipForMutation(getDb(), f.used.id);
    expect(mutation?.usages).toContainEqual({ id: f.otherUsage.id, registrationId: null });
    const listed = await listSponsorships(f.event.id, listQuery({ status: "USED" }));
    expect(listed.data[0].usages).toContainEqual({ registrationId: null, amountApplied: 200 });
    expect(await getRegistrationForSponsorship(f.other.id)).toBeNull();
  });

  it("by-code keeps its batch shape and raw null array while pending projection normalizes coverage", async () => {
    const f = await fixture();
    expect(await getSponsorshipByCode(f.event.id, f.pending.code)).toEqual({
      ...f.pending,
      coveredAccessIds: null,
      batch: { ...batchSummary(f), phone: null },
    });
    expect(await getSponsorshipByCode(randomUUID(), f.pending.code)).toBeNull();
    expect(await getSponsorshipByCode(f.event.id, f.pending.code.toLowerCase())).toBeNull();
    expect(await getPendingSponsorships(f.event.id)).toEqual([{
      id: f.pending.id,
      code: f.pending.code,
      beneficiaryName: f.pending.beneficiaryName,
      beneficiaryEmail: f.pending.beneficiaryEmail,
      totalAmount: 90,
      coversBasePrice: false,
      coveredAccessIds: [],
      batch: { labName: f.batch.labName },
    }]);
    expect(await getSponsorshipById(f.pending.id)).toEqual({
      ...f.pending, batch: f.batch, event: { clientId: f.client.id }, usages: [], coveredAccessItems: [],
    });
  });

  it("mutation, batch-event and link reads preserve nested false/null gates and their distinct event/batch projections", async () => {
    const f = await fixture();
    const gate = { active: false, enabledModules: null };
    expect(await findSponsorshipForMutation(getDb(), f.pending.id)).toEqual({
      ...f.pending,
      event: { clientId: f.client.id, status: "ARCHIVED", client: gate },
      usages: [],
    });
    expect(await findEventForBatch(getDb(), f.event.id)).toEqual({
      id: f.event.id,
      name: f.event.name,
      slug: f.event.slug,
      status: "ARCHIVED",
      startDate: f.event.startDate,
      location: null,
      clientId: f.client.id,
      client: { ...gate, name: f.client.name },
    });
    expect(await findSponsorshipForLink(getDb(), f.pending.id)).toEqual({
      ...f.pending,
      event: {
        clientId: f.client.id,
        name: f.event.name,
        slug: f.event.slug,
        startDate: f.event.startDate,
        location: null,
        status: "ARCHIVED",
        client: { ...gate, name: f.client.name },
      },
      batch: { labName: f.batch.labName, contactName: f.batch.contactName, email: f.batch.email },
    });
  });

  it("registration coverage/link/batch projections and linked sponsorships normalize nullable arrays without dropping their usage metadata", async () => {
    const f = await fixture();
    const pendingUsage = await seedSponsorshipUsage({ sponsorshipId: f.pending.id, registrationId: f.registration.id, amountApplied: 0, appliedBy: "mapping-test" });
    const existingUsages = [
      { sponsorshipId: f.used.id, sponsorship: { code: f.used.code, coversBasePrice: true, coveredAccessIds: [f.access.id] } },
      { sponsorshipId: f.pending.id, sponsorship: { code: f.pending.code, coversBasePrice: false, coveredAccessIds: [] } },
    ];
    const coverage = await getRegistrationCoverage(f.registration.id);
    expect(coverage).toEqual({
      id: f.registration.id,
      eventId: f.event.id,
      totalAmount: 500,
      baseAmount: 400,
      accessTypeIds: [],
      priceBreakdown: breakdown(f.access.id),
      existingUsages: expect.arrayContaining(existingUsages),
    });
    expect(coverage?.existingUsages).toHaveLength(2);
    const linkedRegistration = await findRegistrationForLink(getDb(), f.registration.id);
    expect(linkedRegistration).toEqual({
      ...registrationForBatch(f),
      eventId: f.event.id,
      paidAmount: 0,
      existingUsages: expect.arrayContaining(existingUsages),
    });
    expect(linkedRegistration?.existingUsages).toHaveLength(2);
    expect(await findRegistrationsForBatch(getDb(), f.event.id, [f.registration.id])).toEqual([registrationForBatch(f)]);
    expect(await findRegistrationsForBatch(getDb(), randomUUID(), [f.registration.id])).toEqual([]);
    expect(await findRegistrationsForBatch(getDb(), f.event.id, [])).toEqual([]);
    expect(await getRegistrationForSponsorship(f.registration.id)).toEqual({ id: f.registration.id, event: { id: f.event.id, clientId: f.client.id } });
    const linked = await getLinkedSponsorships(f.registration.id);
    expect(linked).toHaveLength(2);
    for (const [sponsor, usage] of [[f.used, f.usage], [f.pending, pendingUsage]] as const) {
      expect(linked.find((item) => item.id === sponsor.id)).toEqual({
        id: sponsor.id, code: sponsor.code, status: sponsor.status,
        beneficiaryName: sponsor.beneficiaryName, beneficiaryEmail: sponsor.beneficiaryEmail,
        coversBasePrice: sponsor.coversBasePrice, coveredAccessIds: sponsor.coveredAccessIds ?? [],
        totalAmount: sponsor.totalAmount, batch: batchSummary(f),
        usage: { id: usage.id, amountApplied: usage.amountApplied, appliedAt: usage.appliedAt },
      });
    }
  });

  it("search rebuilds coverage from USED sponsorships only and normalizes a null access array", async () => {
    const f = await fixture();
    const ignoredAccess = await seedEventAccess({ eventId: f.event.id, name: "Cancelled coverage" });
    // A lingering cancelled usage must not appear as usable sponsorship coverage.
    const cancelledWithCoverage = await seedSponsorship({
      eventId: f.event.id, batchId: f.batch.id, status: "CANCELLED",
      coversBasePrice: false, coveredAccessIds: [ignoredAccess.id], totalAmount: 0,
    });
    for (const sponsor of [f.pending, cancelledWithCoverage]) {
      await seedSponsorshipUsage({ sponsorshipId: sponsor.id, registrationId: f.registration.id, amountApplied: 0, appliedBy: "mapping-test" });
    }
    const query = { query: "MappingAlice", unpaidOnly: true, limit: 10 };
    expect(await searchRegistrantsForSponsorship(f.event.id, query)).toEqual([{
      id: f.registration.id, email: f.registration.email, firstName: "MappingAlice", lastName: null,
      paymentStatus: "PARTIAL", totalAmount: 500, baseAmount: 400, accessAmount: 100, sponsorshipAmount: 200,
      accessTypeIds: [], coveredAccessIds: [f.access.id], isBasePriceCovered: true,
    }]);
    expect(await searchRegistrantsForSponsorship(randomUUID(), query)).toEqual([]);
    expect(await searchRegistrantsForSponsorship(f.event.id, { ...query, query: "absent-name" })).toEqual([]);
  });

  it("sponsor-form query projections preserve the checked stored schema and event/type scope", async () => {
    const f = await fixture();
    expect(await findSponsorFormById(getDb(), f.sponsorForm.id, f.event.id)).toEqual({ id: f.sponsorForm.id, schema: f.sponsorSchema });
    expect(await getActiveSponsorForm(f.event.id)).toEqual({ id: f.sponsorForm.id, eventId: f.event.id, schema: f.sponsorSchema });
    expect(await getFormSchema(getDb(), f.sponsorForm.id)).toEqual(f.sponsorSchema);
    expect(await findSponsorFormById(getDb(), f.form.id, f.event.id)).toBeNull();
    expect(await findSponsorFormById(getDb(), f.sponsorForm.id, randomUUID())).toBeNull();
  });

  it("missing roots remain null and empty relation reads remain empty", async () => {
    const missing = randomUUID();
    expect(await getSponsorshipById(missing)).toBeNull();
    expect(await getSponsorshipByCode(missing, "SP-NOT-PRESENT")).toBeNull();
    expect(await findSponsorshipForMutation(getDb(), missing)).toBeNull();
    expect(await findSponsorshipForLink(getDb(), missing)).toBeNull();
    expect(await findEventForBatch(getDb(), missing)).toBeNull();
    expect(await getRegistrationCoverage(missing)).toBeNull();
    expect(await findRegistrationForLink(getDb(), missing)).toBeNull();
    expect(await getRegistrationForSponsorship(missing)).toBeNull();
    expect(await getLinkedSponsorships(missing)).toEqual([]);
    expect(await getPendingSponsorships(missing)).toEqual([]);
    expect(await getActiveSponsorForm(missing)).toBeNull();
    expect(await getFormSchema(getDb(), missing)).toBeNull();
    const empty = await listSponsorships(missing, listQuery({}));
    expect(empty.data).toEqual([]);
    expect(empty.total).toBe(0);
    expect(empty.stats).toEqual({ total: 0, totalAmount: 0, pending: { count: 0, amount: 0 }, used: { count: 0, amount: 0 }, cancelled: { count: 0, amount: 0 } });
  });
});
