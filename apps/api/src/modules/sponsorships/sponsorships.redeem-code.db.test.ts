import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ErrorCodes } from "@app/contracts";
import { findRegistrationForMutation, getAccessPaidCount, withTxn } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import {
  auditRowsOf,
  readSponsorshipRow,
  realtimeRowsOf,
  seedClient,
  seedEvent,
  seedEventAccess,
  seedForm,
  seedSponsorship,
  seedSponsorshipBatch,
  sponsorshipUsagesOf,
} from "@app/db/testing/fixtures";
import type { Config } from "../../core/config";
import { AccessService } from "../access/access.service";
import { PricingService } from "../pricing/pricing.service";
import { RegistrationCreateService } from "../registrations/registrations.create.service";
import { RegistrationSideEffects } from "../registrations/registrations.side-effects";
import { SponsorshipsPublicService } from "./sponsorships.public.service";

// A registrant redeems a laboratory's code on the payment page, after signing
// up: same consumption rules as a code given at signup (single use, locked
// first), only in CODE mode, only while the registration is PENDING/PARTIAL.

const access = new AccessService();
const creator = new RegistrationCreateService(
  access,
  new PricingService(),
  { publicLinkAllowedOrigins: ["https://events.example.com"] } as Config,
  new RegistrationSideEffects(access),
);
const service = new SponsorshipsPublicService(access);

async function setup(sponsorshipMode: "CODE" | "LINKED_ACCOUNT" = "CODE") {
  const client = await seedClient({ enabledModules: ["registrations", "pricing", "sponsorships"] });
  const event = await seedEvent({ clientId: client.id, status: "OPEN", endDate: new Date("2099-01-01T00:00:00.000Z") });
  const form = await seedForm({ eventId: event.id, schema: { steps: [{ fields: [] }] } as never });
  const sponsorForm = await seedForm({
    eventId: event.id,
    type: "SPONSOR",
    name: "Sponsor",
    schema: {
      formType: "SPONSOR",
      sponsorSteps: [],
      beneficiaryTemplate: { fields: [], minCount: 1, maxCount: 100 },
      sponsorshipSettings: { sponsorshipMode },
    } as never,
  });
  const gala = await seedEventAccess({ eventId: event.id, name: "Gala", price: 120, type: "ADDON" });
  const tour = await seedEventAccess({ eventId: event.id, name: "Tour", price: 80, type: "ADDON" });
  const batch = await seedSponsorshipBatch({ eventId: event.id, formId: sponsorForm.id });
  return { event, form, gala, tour, batch };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function newCode(): string {
  return `SP-${randomUUID().slice(0, 8).toUpperCase()}`;
}

async function signup(s: Setup): Promise<string> {
  const result = await creator.createPublicRegistration(s.form.id, {
    formData: {},
    email: `reg-${Math.random().toString(36).slice(2)}@example.test`,
    firstName: "Test",
    lastName: "Registrant",
    accessSelections: [
      { accessId: s.gala.id, quantity: 1 },
      { accessId: s.tour.id, quantity: 1 },
    ],
  } as never);
  return result.registration.id;
}

async function readRegistration(id: string) {
  const row = await withTxn((tx) => findRegistrationForMutation(id, tx));
  if (!row) throw new Error(`registration ${id} not found`);
  return row;
}

describe.runIf(dbTestsEnabled())("sponsorship code redeemed on the payment page", () => {
  it("a fully covering code makes the registration SPONSORED, uses the code and takes paid places", async () => {
    const s = await setup();
    const code = newCode();
    const sponsorship = await seedSponsorship({
      batchId: s.batch.id,
      eventId: s.event.id,
      code,
      totalAmount: 200,
      coversBasePrice: true,
      coveredAccessIds: [s.gala.id, s.tour.id],
    });
    const registrationId = await signup(s);
    expect((await readRegistration(registrationId)).paymentStatus).toBe("PENDING");

    const result = await service.redeemSponsorshipCode(registrationId, ` ${code.toLowerCase()} `);

    expect(result).toEqual({ paymentStatus: "SPONSORED", totalAmount: 200, sponsorshipAmount: 200, amountDue: 0 });
    expect(await readRegistration(registrationId)).toMatchObject({
      paymentStatus: "SPONSORED",
      sponsorshipAmount: 200,
      paymentMethod: "LAB_SPONSORSHIP",
      sponsorshipCode: code,
    });
    expect((await readSponsorshipRow(sponsorship.id)).status).toBe("USED");
    const usages = await sponsorshipUsagesOf(sponsorship.id);
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ registrationId, amountApplied: 200, appliedBy: "PUBLIC" });
    expect((await getAccessPaidCount(s.gala.id))!.paidCount).toBe(1);
    const audits = await auditRowsOf("Sponsorship", sponsorship.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "LINK_TO_REGISTRATION", performedBy: "PUBLIC" });
    expect(await realtimeRowsOf("sponsorship.linked", sponsorship.id)).toHaveLength(1);
  });

  it("a partially covering code leaves the registration PARTIAL with the balance due", async () => {
    const s = await setup();
    const code = newCode();
    await seedSponsorship({
      batchId: s.batch.id,
      eventId: s.event.id,
      code,
      totalAmount: 120,
      coversBasePrice: false,
      coveredAccessIds: [s.gala.id],
    });
    const registrationId = await signup(s);

    const result = await service.redeemSponsorshipCode(registrationId, code);

    expect(result).toEqual({ paymentStatus: "PARTIAL", totalAmount: 200, sponsorshipAmount: 120, amountDue: 80 });
    expect((await getAccessPaidCount(s.gala.id))!.paidCount).toBe(1);
    expect((await getAccessPaidCount(s.tour.id))!.paidCount).toBe(0);
  });

  it("a code already redeemed by another registration is refused with 409", async () => {
    const s = await setup();
    const code = newCode();
    await seedSponsorship({
      batchId: s.batch.id,
      eventId: s.event.id,
      code,
      totalAmount: 200,
      coversBasePrice: true,
      coveredAccessIds: [s.gala.id, s.tour.id],
    });
    const first = await signup(s);
    const second = await signup(s);
    await service.redeemSponsorshipCode(first, code);

    await expect(service.redeemSponsorshipCode(second, code)).rejects.toMatchObject({
      code: ErrorCodes.SPONSORSHIP_CODE_ALREADY_USED,
      statusCode: 409,
    });
    expect(await readRegistration(second)).toMatchObject({ paymentStatus: "PENDING", sponsorshipAmount: 0 });
  });

  it("an unknown code is refused with 400", async () => {
    const s = await setup();
    const registrationId = await signup(s);
    await expect(service.redeemSponsorshipCode(registrationId, newCode())).rejects.toMatchObject({
      code: ErrorCodes.INVALID_SPONSORSHIP_CODE,
      statusCode: 400,
    });
  });

  it("is refused in LINKED_ACCOUNT mode, leaving the code unused", async () => {
    const s = await setup("LINKED_ACCOUNT");
    const code = newCode();
    const sponsorship = await seedSponsorship({
      batchId: s.batch.id,
      eventId: s.event.id,
      code,
      totalAmount: 200,
      coversBasePrice: true,
      coveredAccessIds: [s.gala.id, s.tour.id],
    });
    const registrationId = await signup(s);

    await expect(service.redeemSponsorshipCode(registrationId, code)).rejects.toMatchObject({ statusCode: 400 });
    expect((await readSponsorshipRow(sponsorship.id)).status).toBe("PENDING");
  });
});
