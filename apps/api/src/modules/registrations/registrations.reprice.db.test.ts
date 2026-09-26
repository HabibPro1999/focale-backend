import { describe, expect, it } from "vitest";
import { ErrorCodes } from "@app/contracts";
import {
  findRegistrationForMutation,
  findRegistrationUsagesForRecalc,
  getAccessPaidCount,
  getAccessRegisteredCount,
  withTxn,
} from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import {
  seedEvent,
  seedEventAccess,
  seedForm,
  seedRegistration,
  seedSponsorship,
  seedSponsorshipBatch,
  seedSponsorshipUsage,
} from "../../../../../packages/db/tests/helpers/factories";
import { AccessService } from "../access/access.service";
import { PricingService } from "../pricing/pricing.service";
import { RegistrationRepricer } from "./registrations.repricer";
import { RegistrationSideEffects } from "./registrations.side-effects";

// Plan 2.6c: the admin edit and the public self-edit reprice through
// repriceRegistration (codeless pricing, access counters by delta, the
// settlement under the registration lock), and a price change of a PAID
// registration is refused unless an admin says how the payment follows.

const access = new AccessService();
const repricer = new RegistrationRepricer(
  access,
  new PricingService(),
  new RegistrationSideEffects(access),
);

type AccessRow = { id: string; price: number };

/** A stored breakdown for `items` (no base price: the event has no pricing row). */
function breakdown(items: AccessRow[], sponsorship = 0) {
  const accessItems = items.map((item) => ({
    accessId: item.id,
    name: "Access",
    unitPrice: item.price,
    quantity: 1,
    subtotal: item.price,
  }));
  const subtotal = accessItems.reduce((sum, item) => sum + item.subtotal, 0);
  return {
    basePrice: 0,
    appliedRules: [],
    calculatedBasePrice: 0,
    accessItems,
    accessTotal: subtotal,
    subtotal,
    sponsorships: [],
    sponsorshipTotal: sponsorship,
    total: subtotal - sponsorship,
    currency: "TND",
    droppedAccessItems: [],
  };
}

async function eventWithForm() {
  const event = await seedEvent({ status: "OPEN", endDate: new Date("2099-01-01T00:00:00.000Z") });
  const form = await seedForm({ eventId: event.id });
  return { event, form };
}

/** ADDON items: any number can be selected together. */
function seedAddon(eventId: string, name: string, price: number, values: Parameters<typeof seedEventAccess>[0] = {}) {
  return seedEventAccess({ eventId, name, price, type: "ADDON", ...values });
}

async function seedWithItems(
  eventId: string,
  formId: string,
  items: AccessRow[],
  values: Parameters<typeof seedRegistration>[0] = {},
) {
  const pb = breakdown(items, values.sponsorshipAmount ?? 0);
  return seedRegistration({
    eventId,
    formId,
    totalAmount: pb.subtotal,
    accessAmount: pb.accessTotal,
    priceBreakdown: pb,
    accessTypeIds: items.map((item) => item.id),
    ...values,
  });
}

async function readRegistration(id: string) {
  const row = await withTxn((tx) => findRegistrationForMutation(id, tx));
  if (!row) throw new Error(`registration ${id} not found`);
  return row;
}

async function counts(accessId: string) {
  const [paid, registered] = await Promise.all([getAccessPaidCount(accessId), getAccessRegisteredCount(accessId)]);
  return { paid: paid!.paidCount, registered: registered!.registeredCount };
}

const PAID_AT = new Date("2027-01-01T00:00:00.000Z");

describe.runIf(dbTestsEnabled())("registration repricing (2.6c)", () => {
  it("moves the access registered counters by the delta on an admin access edit", async () => {
    const { event, form } = await eventWithForm();
    const a = await seedAddon(event.id, "A", 100, { registeredCount: 1 });
    const b = await seedAddon(event.id, "B", 50, { registeredCount: 1 });
    const c = await seedAddon(event.id, "C", 30);
    const registration = await seedWithItems(event.id, form.id, [a, b]);

    await repricer.adminEditRegistration(
      event.id,
      registration.id,
      { accessSelections: [{ accessId: b.id, quantity: 1 }, { accessId: c.id, quantity: 1 }] } as never,
      "admin-1",
    );

    const row = await readRegistration(registration.id);
    expect(row).toMatchObject({ paymentStatus: "PENDING", totalAmount: 80, accessAmount: 80, accessTypeIds: [b.id, c.id] });
    expect(row.priceBreakdown).toMatchObject({ subtotal: 80, total: 80, sponsorshipTotal: 0 });
    expect(await counts(a.id)).toEqual({ paid: 0, registered: 0 });
    expect(await counts(b.id)).toEqual({ paid: 0, registered: 1 });
    expect(await counts(c.id)).toEqual({ paid: 0, registered: 1 });
  });

  it("keeps an unchanged item at capacity when a PAID registration adds a free item", async () => {
    const { event, form } = await eventWithForm();
    // The registration holds the last paid place of X.
    const x = await seedAddon(event.id, "X", 100, { maxCapacity: 1, registeredCount: 1, paidCount: 1 });
    const free = await seedAddon(event.id, "Free", 0);
    const registration = await seedWithItems(event.id, form.id, [x], {
      paymentStatus: "PAID",
      paidAmount: 100,
      paidAt: PAID_AT,
    });

    await repricer.adminEditRegistration(
      event.id,
      registration.id,
      { accessSelections: [{ accessId: x.id, quantity: 1 }, { accessId: free.id, quantity: 1 }] } as never,
      "admin-1",
    );

    expect(await readRegistration(registration.id)).toMatchObject({
      paymentStatus: "PAID",
      paidAmount: 100,
      totalAmount: 100,
      paidAt: PAID_AT,
      accessTypeIds: [x.id, free.id],
    });
    expect(await counts(x.id)).toEqual({ paid: 1, registered: 1 });
    // PAID holds every item in paid capacity.
    expect(await counts(free.id)).toEqual({ paid: 1, registered: 1 });
  });

  it("refuses a self-edit that would change a PAID registration's price and changes nothing", async () => {
    const { event, form } = await eventWithForm();
    const x = await seedAddon(event.id, "X", 100, { registeredCount: 1, paidCount: 1 });
    const y = await seedAddon(event.id, "Y", 50);
    const registration = await seedWithItems(event.id, form.id, [x], {
      paymentStatus: "PAID",
      paidAmount: 100,
      paidAt: PAID_AT,
    });

    await expect(
      repricer.editRegistrationPublic(registration.id, {
        expectedUpdatedAt: registration.updatedAt.toISOString(),
        accessSelections: [{ accessId: x.id, quantity: 1 }, { accessId: y.id, quantity: 1 }],
      }),
    ).rejects.toMatchObject({
      code: ErrorCodes.REGISTRATION_PRICE_LOCKED,
      statusCode: 409,
      details: { currentNet: 100, newNet: 150 },
    });

    const row = await readRegistration(registration.id);
    expect(row).toMatchObject({ paymentStatus: "PAID", paidAmount: 100, totalAmount: 100, accessTypeIds: [x.id] });
    expect(row.updatedAt.getTime()).toBe(registration.updatedAt.getTime());
    // The registered-count move before the refusal rolled back.
    expect(await counts(y.id)).toEqual({ paid: 0, registered: 0 });
    expect(await counts(x.id)).toEqual({ paid: 1, registered: 1 });
  });

  it("refuses an admin price edit of a PAID registration until the admin sets the payment", async () => {
    const { event, form } = await eventWithForm();
    const x = await seedAddon(event.id, "X", 100, { registeredCount: 2, paidCount: 2 });
    const y = await seedAddon(event.id, "Y", 50);
    const first = await seedWithItems(event.id, form.id, [x], { paymentStatus: "PAID", paidAmount: 100, paidAt: PAID_AT });
    const second = await seedWithItems(event.id, form.id, [x], { paymentStatus: "PAID", paidAmount: 100, paidAt: PAID_AT });
    const addY = { accessSelections: [{ accessId: x.id, quantity: 1 }, { accessId: y.id, quantity: 1 }] };

    await expect(
      repricer.adminEditRegistration(event.id, first.id, addY as never, "admin-1"),
    ).rejects.toMatchObject({
      code: ErrorCodes.PAYMENT_ADJUSTMENT_REQUIRED,
      statusCode: 409,
      details: { currentNet: 100, newNet: 150, paidAmount: 100 },
    });
    expect(await readRegistration(first.id)).toMatchObject({ paymentStatus: "PAID", totalAmount: 100, accessTypeIds: [x.id] });
    expect(await counts(y.id)).toEqual({ paid: 0, registered: 0 });

    // Collected the difference: stays PAID for the new net.
    await repricer.adminEditRegistration(event.id, first.id, { ...addY, paidAmount: 150 } as never, "admin-1");
    expect(await readRegistration(first.id)).toMatchObject({
      paymentStatus: "PAID",
      paidAmount: 150,
      totalAmount: 150,
      paidAt: PAID_AT,
      accessTypeIds: [x.id, y.id],
    });
    expect(await counts(y.id)).toEqual({ paid: 1, registered: 1 });

    // Owed the difference: PARTIAL, which holds no paid place without a sponsorship.
    await repricer.adminEditRegistration(event.id, second.id, { ...addY, paymentStatus: "PARTIAL" } as never, "admin-1");
    expect(await readRegistration(second.id)).toMatchObject({
      paymentStatus: "PARTIAL",
      paidAmount: 100,
      totalAmount: 150,
      accessTypeIds: [x.id, y.id],
    });
    expect(await counts(x.id)).toEqual({ paid: 1, registered: 2 });
    expect(await counts(y.id)).toEqual({ paid: 1, registered: 2 });
  });

  it("keeps the price of a self-edit that changes no answer and no access", async () => {
    const { event, form } = await eventWithForm();
    // X costs 200 now; the registration was priced at 100.
    const x = await seedAddon(event.id, "X", 200, { registeredCount: 1, paidCount: 1 });
    const registration = await seedWithItems(event.id, form.id, [{ id: x.id, price: 100 }], {
      paymentStatus: "PAID",
      paidAmount: 100,
      paidAt: PAID_AT,
    });

    const result = await repricer.editRegistrationPublic(registration.id, {
      expectedUpdatedAt: registration.updatedAt.toISOString(),
      firstName: "Renamed",
      accessSelections: [{ accessId: x.id, quantity: 1 }],
    });

    expect(result.priceBreakdown).toMatchObject({ total: 100 });
    expect(await readRegistration(registration.id)).toMatchObject({
      firstName: "Renamed",
      paymentStatus: "PAID",
      paidAmount: 100,
      totalAmount: 100,
    });
    expect(await counts(x.id)).toEqual({ paid: 1, registered: 1 });
  });

  it("does not apply the registration's own sponsorship code when repricing", async () => {
    const { event, form } = await eventWithForm();
    const a = await seedAddon(event.id, "A", 100, { registeredCount: 1 });
    const b = await seedAddon(event.id, "B", 50);
    const batch = await seedSponsorshipBatch({ eventId: event.id, formId: form.id });
    // Typed at signup, never linked, still unused: pricing it again would
    // take 50 off without consuming it.
    const code = await seedSponsorship({
      batchId: batch.id,
      eventId: event.id,
      coversBasePrice: false,
      coveredAccessIds: [b.id],
      totalAmount: 50,
      status: "PENDING",
    });
    const registration = await seedWithItems(event.id, form.id, [a], { sponsorshipCode: code.code });

    await repricer.adminEditRegistration(
      event.id,
      registration.id,
      { accessSelections: [{ accessId: a.id, quantity: 1 }, { accessId: b.id, quantity: 1 }] } as never,
      "admin-1",
    );

    const row = await readRegistration(registration.id);
    expect(row).toMatchObject({ paymentStatus: "PENDING", totalAmount: 150, sponsorshipAmount: 0 });
    expect(row.priceBreakdown).toMatchObject({ subtotal: 150, sponsorshipTotal: 0, total: 150 });
  });

  it("reprices against the linked sponsorship", async () => {
    const { event, form } = await eventWithForm();
    const a = await seedAddon(event.id, "A", 100, { registeredCount: 1, paidCount: 1 });
    const b = await seedAddon(event.id, "B", 50);
    const batch = await seedSponsorshipBatch({ eventId: event.id, formId: form.id });
    const linked = await seedSponsorship({
      batchId: batch.id,
      eventId: event.id,
      coversBasePrice: false,
      coveredAccessIds: [a.id],
      totalAmount: 100,
      status: "USED",
    });
    const registration = await seedWithItems(event.id, form.id, [a], {
      paymentStatus: "SPONSORED",
      paidAt: PAID_AT,
      sponsorshipAmount: 100,
    });
    await seedSponsorshipUsage({
      sponsorshipId: linked.id,
      registrationId: registration.id,
      amountApplied: 100,
      appliedBy: "test",
    });

    await repricer.adminEditRegistration(
      event.id,
      registration.id,
      { accessSelections: [{ accessId: a.id, quantity: 1 }, { accessId: b.id, quantity: 1 }] } as never,
      "admin-1",
    );

    // A stays covered, B is owed: no longer fully sponsored.
    const row = await readRegistration(registration.id);
    expect(row).toMatchObject({
      paymentStatus: "PARTIAL",
      paidAt: null,
      totalAmount: 150,
      sponsorshipAmount: 100,
      accessTypeIds: [a.id, b.id],
    });
    expect(row.priceBreakdown).toMatchObject({ subtotal: 150, sponsorshipTotal: 100, total: 50 });
    const [usage] = await withTxn((tx) => findRegistrationUsagesForRecalc(registration.id, tx));
    expect(usage!.amountApplied).toBe(100);
    // PARTIAL holds the covered item only.
    expect(await counts(a.id)).toEqual({ paid: 1, registered: 1 });
    expect(await counts(b.id)).toEqual({ paid: 0, registered: 1 });
  });
});
