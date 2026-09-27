import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  findEventForBatch, findSponsorshipForLink, findSponsorshipForMutation,
  findSponsorshipForRecalc, findSponsorshipUnlinkState, getDb,
  getLinkedSponsorships, getSponsorshipByCode, getSponsorshipById,
  listSponsorships, searchRegistrantsForSponsorship, sponsorships,
} from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { cleanupDatabase } from "../helpers/cleanup";
import {
  seedClient, seedEvent, seedEventAccess, seedForm, seedRegistration,
  seedSponsorship, seedSponsorshipBatch, seedSponsorshipUsage,
} from "../helpers/factories";

async function fixture() {
  const client = await seedClient({ name: "Client différent", active: false, enabledModules: null });
  const event = await seedEvent({ clientId: client.id, name: "Event différent", status: "CLOSED", location: null });
  const form = await seedForm({ eventId: event.id });
  const batch = await seedSponsorshipBatch({ eventId: event.id, formId: form.id, labName: "Lab différent", contactName: "Contact différent", email: "batch@example.test", phone: null });
  const sponsor = await seedSponsorship({ eventId: event.id, batchId: batch.id, coveredAccessIds: null, totalAmount: 700, status: "USED" });
  const registration = await seedRegistration({
    eventId: event.id, formId: form.id, email: "person@example.test", firstName: null, lastName: "Ben Salah",
    totalAmount: 1000, paidAmount: 300, baseAmount: 800, paymentStatus: "PARTIAL",
    paidAt: new Date("2030-02-03T04:05:06.123Z"), accessTypeIds: null,
    priceBreakdown: { subtotal: 1000, accessItems: [{ id: "kept", price: 200 }] },
  });
  const linked = await seedSponsorshipUsage({ sponsorshipId: sponsor.id, registrationId: registration.id, amountApplied: 500, appliedBy: "mapping-test" });
  const orphan = await seedSponsorshipUsage({ sponsorshipId: sponsor.id, registrationId: null, amountApplied: 200, appliedBy: "mapping-test" });
  return { client, event, batch, sponsor, registration, linked, orphan };
}

describe.runIf(dbTestsEnabled())("sponsorship read mapping characterization", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it("keeps event/client/batch aliases distinct and nullable gate fields intact", async () => {
    const { client, event, batch, sponsor, linked, orphan } = await fixture();
    const db = getDb();
    const gate = { active: false, enabledModules: null };
    expect(await findEventForBatch(db, event.id)).toEqual({
      id: event.id, name: event.name, slug: event.slug, status: "CLOSED",
      startDate: event.startDate, location: null, clientId: client.id,
      client: { ...gate, name: client.name },
    });
    expect(await findSponsorshipForLink(db, sponsor.id)).toEqual({
      ...sponsor,
      event: { clientId: client.id, name: event.name, slug: event.slug, startDate: event.startDate, location: null, status: "CLOSED", client: { ...gate, name: client.name } },
      batch: { labName: batch.labName, contactName: batch.contactName, email: batch.email },
    });
    const mutation = await findSponsorshipForMutation(db, sponsor.id);
    expect(mutation).toEqual({
      ...sponsor, event: { clientId: client.id, status: "CLOSED", client: gate },
      usages: expect.arrayContaining([
        { id: linked.id, registrationId: linked.registrationId },
        { id: orphan.id, registrationId: null },
      ]),
    });
    expect(mutation?.usages).toHaveLength(2);
    expect(await findSponsorshipUnlinkState(db, sponsor.id)).toEqual({
      status: "USED", coveredAccessIds: [], event: { status: "CLOSED", client: gate },
    });
    expect(await getSponsorshipByCode(event.id, sponsor.code)).toEqual({
      ...sponsor, batch: { id: batch.id, labName: batch.labName, contactName: batch.contactName, email: batch.email, phone: null },
    });
    expect(await getSponsorshipByCode("00000000-0000-4000-8000-000000000001", sponsor.code)).toBeNull();
  });

  it("distinguishes a missing left-joined registration from nullable registration fields", async () => {
    const { client, batch, sponsor, registration: reg, linked, orphan } = await fixture();
    const detail = await getSponsorshipById(sponsor.id);
    expect(detail).toEqual({
      ...sponsor, event: { clientId: client.id }, batch,
      usages: expect.arrayContaining([
        { ...linked, registration: { id: reg.id, email: reg.email, firstName: null, lastName: reg.lastName } },
        { ...orphan, registration: null },
      ]), coveredAccessItems: [],
    });
    expect(detail?.usages).toHaveLength(2);
    const recalc = await findSponsorshipForRecalc(getDb(), sponsor.id);
    expect(recalc).toEqual({
      coversBasePrice: true, coveredAccessIds: [], totalAmount: 700,
      usages: expect.arrayContaining([
        { id: linked.id, registration: {
          id: reg.id, eventId: reg.eventId, totalAmount: 1000, paidAmount: 300,
          baseAmount: 800, paymentStatus: "PARTIAL", paidAt: reg.paidAt,
          accessTypeIds: [], priceBreakdown: reg.priceBreakdown,
        } },
        { id: orphan.id, registration: null },
      ]),
    });
    expect(recalc?.usages).toHaveLength(2);
  });

  it("preserves linked/list response shapes, normalized arrays and page statistics", async () => {
    const { event, batch, sponsor, registration, linked, orphan } = await fixture();
    const batchSummary = { id: batch.id, labName: batch.labName, contactName: batch.contactName, email: batch.email };
    expect(await getLinkedSponsorships(registration.id)).toEqual([{
      id: sponsor.id, code: sponsor.code, status: sponsor.status,
      beneficiaryName: sponsor.beneficiaryName, beneficiaryEmail: sponsor.beneficiaryEmail,
      coversBasePrice: true, coveredAccessIds: [], totalAmount: 700,
      batch: batchSummary, usage: { id: linked.id, amountApplied: 500, appliedAt: linked.appliedAt },
    }]);
    const page = await listSponsorships(event.id, { offset: 0, limit: 20, sortBy: "createdAt", sortOrder: "desc" });
    expect(page.data).toEqual([{
      ...sponsor, batch: batchSummary,
      usages: expect.arrayContaining([
        { registrationId: linked.registrationId, amountApplied: 500 },
        { registrationId: orphan.registrationId, amountApplied: 200 },
      ]),
    }]);
    expect(page.data[0].usages).toHaveLength(2);
    expect(page.total).toBe(1);
    expect(page.stats).toEqual({ total: 1, totalAmount: 700, pending: { count: 0, amount: 0 }, used: { count: 1, amount: 700 }, cancelled: { count: 0, amount: 0 } });
  });

  it("keeps full-match totals and statistics on partial and empty later pages", async () => {
    const { event, batch, sponsor } = await fixture();
    await getDb().update(sponsorships).set({ beneficiaryName: "A" }).where(eq(sponsorships.id, sponsor.id));
    const second = await seedSponsorship({ eventId: event.id, batchId: batch.id, beneficiaryName: "B", status: "PENDING", totalAmount: 200 });
    await seedSponsorship({ eventId: event.id, batchId: batch.id, beneficiaryName: "C", status: "CANCELLED", totalAmount: 100 });
    const stats = { total: 3, totalAmount: 1000, pending: { count: 1, amount: 200 }, used: { count: 1, amount: 700 }, cancelled: { count: 1, amount: 100 } };
    const page = await listSponsorships(event.id, { offset: 1, limit: 1, sortBy: "beneficiaryName", sortOrder: "asc" });
    expect(page.data.map((row) => row.id)).toEqual([second.id]);
    expect(page.total).toBe(3);
    expect(page.stats).toEqual(stats);
    const empty = await listSponsorships(event.id, { offset: 4, limit: 1, sortBy: "beneficiaryName", sortOrder: "asc" });
    expect(empty.data).toEqual([]);
    expect(empty.total).toBe(3);
    expect(empty.stats).toEqual(stats);
  });

  it("groups only USED coverage for each registrant and normalizes nullable arrays", async () => {
    const { event, batch, registration: reg } = await fixture();
    const access = await seedEventAccess({ eventId: event.id });
    const unused = await seedSponsorship({ eventId: event.id, batchId: batch.id, status: "PENDING", coversBasePrice: false, coveredAccessIds: ["ignored"] });
    const used = await seedSponsorship({ eventId: event.id, batchId: batch.id, status: "USED", coversBasePrice: false, coveredAccessIds: [access.id, access.id] });
    await seedSponsorshipUsage({ sponsorshipId: unused.id, registrationId: reg.id, amountApplied: 0, appliedBy: "mapping-test" });
    await seedSponsorshipUsage({ sponsorshipId: used.id, registrationId: reg.id, amountApplied: 100, appliedBy: "mapping-test" });

    expect(await searchRegistrantsForSponsorship(event.id, { query: "person", unpaidOnly: true, limit: 10 })).toEqual([{
      id: reg.id, email: reg.email, firstName: null, lastName: reg.lastName,
      paymentStatus: reg.paymentStatus, totalAmount: reg.totalAmount, baseAmount: reg.baseAmount,
      accessAmount: reg.accessAmount, sponsorshipAmount: reg.sponsorshipAmount,
      accessTypeIds: [], coveredAccessIds: [access.id], isBasePriceCovered: true,
      phone: reg.phone, formData: reg.formData,
    }]);
  });

  it("keeps covered access item values and leaves empty/missing reads distinct", async () => {
    const { event, sponsor, batch } = await fixture();
    const access = await seedEventAccess({ eventId: event.id, name: "Workshop", price: 123 });
    await getDb().update(sponsorships).set({ coveredAccessIds: [access.id] }).where(eq(sponsorships.id, sponsor.id));
    expect((await getSponsorshipById(sponsor.id))?.coveredAccessItems).toEqual([{ id: access.id, name: "Workshop", price: 123 }]);
    const unused = await seedSponsorship({ eventId: event.id, batchId: batch.id, coveredAccessIds: [] });
    expect((await getSponsorshipById(unused.id))?.usages).toEqual([]);
    expect((await findSponsorshipForRecalc(getDb(), unused.id))?.usages).toEqual([]);
    const missing = "00000000-0000-4000-8000-000000000001";
    expect(await getSponsorshipById(missing)).toBeNull();
    expect(await findSponsorshipForLink(getDb(), missing)).toBeNull();
    expect(await findSponsorshipForRecalc(getDb(), missing)).toBeNull();
    expect(await findSponsorshipForMutation(getDb(), missing)).toBeNull();
    expect(await findSponsorshipUnlinkState(getDb(), missing)).toBeNull();
    expect(await findEventForBatch(getDb(), missing)).toBeNull();
    expect(await getLinkedSponsorships(missing)).toEqual([]);
  });
});
