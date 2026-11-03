import { describe, expect, it } from "vitest";
import { ErrorCodes } from "@app/contracts";
import {
  findRegistrationForMutation,
  getAccessPaidCount,
  getAccessRegisteredCount,
  withTxn,
} from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { auditRowsOf, seedEvent, seedEventAccess, seedForm, seedUser } from "@app/db/testing/fixtures";
import type { Config } from "../../core/config";
import { AccessService } from "../access/access.service";
import { CheckinService } from "../checkin/checkin.service";
import { PricingService } from "../pricing/pricing.service";
import { RegistrationCreateService } from "./registrations.create.service";
import { RegistrationSideEffects } from "./registrations.side-effects";

// Free event + auto-accept: a public signup that owes nothing (no paid add-on,
// no sponsorship code) is settled WAIVED inside its create transaction, so it
// holds its paid places and can be checked in at once. Any other stays PENDING.

const pricing = new PricingService();
const access = new AccessService();
const checkin = new CheckinService();
const service = new RegistrationCreateService(
  access,
  pricing,
  { publicLinkAllowedOrigins: ["https://events.example.com"] } as Config,
  new RegistrationSideEffects(access),
);

/** An open event with a free and a paid ADDON; pricing set through the PATCH path. */
async function setup(flags: { isFree: boolean; autoAccept: boolean }) {
  const event = await seedEvent({ status: "OPEN", endDate: new Date("2099-01-01T00:00:00.000Z") });
  const form = await seedForm({ eventId: event.id, schema: { steps: [{ fields: [] }] } as never });
  const workshop = await seedEventAccess({ eventId: event.id, name: "Workshop", price: 0, maxCapacity: 10, type: "ADDON" });
  const gala = await seedEventAccess({ eventId: event.id, name: "Gala", price: 50, type: "ADDON" });
  await pricing.updateEventPricing(event.id, { basePrice: 120, ...flags });
  return { event, form, workshop, gala };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function signup(s: Setup, accessIds: string[]) {
  return service.createPublicRegistration(s.form.id, {
    formData: {},
    email: `reg-${Math.random().toString(36).slice(2)}@example.test`,
    firstName: "Free",
    lastName: "Registrant",
    accessSelections: accessIds.map((accessId) => ({ accessId, quantity: 1 })),
  } as never);
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

describe.runIf(dbTestsEnabled())("free event auto-accept at signup", () => {
  it("stores the free flags with a base price of 0", async () => {
    const s = await setup({ isFree: true, autoAccept: true });
    expect(await pricing.getEventPricing(s.event.id)).toMatchObject({ basePrice: 0, isFree: true, autoAccept: true });
  });

  it("refuses auto-accept on a paid event with 400 PRC_6009 and keeps the stored row", async () => {
    const s = await setup({ isFree: false, autoAccept: false });
    await expect(pricing.updateEventPricing(s.event.id, { autoAccept: true })).rejects.toMatchObject({
      code: ErrorCodes.AUTO_ACCEPT_REQUIRES_FREE_EVENT,
      statusCode: 400,
    });
    expect(await pricing.getEventPricing(s.event.id)).toMatchObject({ basePrice: 120, isFree: false, autoAccept: false });
  });

  it("settles a signup that owes nothing WAIVED, takes its paid places and makes it check-in eligible", async () => {
    const s = await setup({ isFree: true, autoAccept: true });

    const result = await signup(s, [s.workshop.id]);

    expect(result.created).toBe(true);
    expect(result.registration.paymentStatus).toBe("WAIVED");
    const id = result.registration.id;
    const row = await readRegistration(id);
    expect(row).toMatchObject({ paymentStatus: "WAIVED", paidAmount: 0, totalAmount: 0 });
    expect(row.paidAt).toBeInstanceOf(Date);
    expect(await counts(s.workshop.id)).toEqual({ paid: 1, registered: 1 });

    const [created] = (await auditRowsOf("Registration", id)).filter((a) => a.action === "CREATE");
    expect(created.changes).toMatchObject({
      paymentStatus: { old: null, new: "WAIVED" },
      autoAccepted: { old: null, new: true },
    });

    expect(await checkin.getCheckInRegistrations(s.event.id)).toContain(id);
    const staff = await seedUser();
    await expect(checkin.checkIn(s.event.id, id, undefined, staff.id)).resolves.toMatchObject({
      success: true,
      alreadyCheckedIn: false,
    });
  });

  it("keeps a signup with a paid add-on PENDING, holding no paid place", async () => {
    const s = await setup({ isFree: true, autoAccept: true });

    const result = await signup(s, [s.workshop.id, s.gala.id]);

    const row = await readRegistration(result.registration.id);
    expect(row).toMatchObject({ paymentStatus: "PENDING", totalAmount: 50, paidAt: null });
    expect(await counts(s.workshop.id)).toEqual({ paid: 0, registered: 1 });
    expect(await counts(s.gala.id)).toEqual({ paid: 0, registered: 1 });
    expect(await checkin.getCheckInRegistrations(s.event.id)).not.toContain(result.registration.id);
  });

  it("keeps a free signup PENDING when auto-accept is off", async () => {
    const s = await setup({ isFree: true, autoAccept: false });

    const result = await signup(s, [s.workshop.id]);

    const row = await readRegistration(result.registration.id);
    expect(row).toMatchObject({ paymentStatus: "PENDING", totalAmount: 0, paidAt: null });
    expect(await counts(s.workshop.id)).toEqual({ paid: 0, registered: 1 });
  });
});
