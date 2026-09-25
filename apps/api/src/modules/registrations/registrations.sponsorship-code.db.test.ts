import { describe, expect, it } from "vitest";
import { ErrorCodes } from "@app/contracts";
import {
  findRegistrationForMutation,
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
import {
  auditRowsOf,
  readSponsorshipRow,
  realtimeRowsOf,
  registrationIdsOfEvent,
  sponsorshipUsagesOf,
} from "../../../../../packages/db/tests/helpers/sponsorship-inspect";
import type { Config } from "../../core/config";
import { AccessService } from "../access/access.service";
import { PricingService } from "../pricing/pricing.service";
import { RegistrationsService } from "./registrations.service";

// Plan 2.7: a sponsorship code is consumed at signup. The public create locks
// the code's sponsorship first, links it (usage + USED) and settles the new
// registration; unknown/cancelled codes → 400, used/reserved/claimed → 409.

const pricing = new PricingService();
const service = new RegistrationsService(
  new AccessService(),
  pricing,
  { publicLinkAllowedOrigins: ["https://events.example.com"] } as Config,
);

/** An open event with an active registration form and two ADDON items (no base price). */
async function setup() {
  const event = await seedEvent({ status: "OPEN", endDate: new Date("2099-01-01T00:00:00.000Z") });
  const form = await seedForm({ eventId: event.id });
  const gala = await seedEventAccess({ eventId: event.id, name: "Gala", price: 120, type: "ADDON" });
  const tour = await seedEventAccess({ eventId: event.id, name: "Tour", price: 80, type: "ADDON" });
  const batch = await seedSponsorshipBatch({ eventId: event.id, formId: form.id });
  return { event, form, gala, tour, batch };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function signup(s: Setup, code: string | undefined, email = `reg-${Math.random().toString(36).slice(2)}@example.test`) {
  return service.createPublicRegistration(s.form.id, {
    formData: {},
    email,
    firstName: "Test",
    lastName: "Registrant",
    accessSelections: [
      { accessId: s.gala.id, quantity: 1 },
      { accessId: s.tour.id, quantity: 1 },
    ],
    ...(code === undefined ? {} : { sponsorshipCode: code }),
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

async function registrationCount(eventId: string) {
  return (await registrationIdsOfEvent(eventId)).length;
}

describe.runIf(dbTestsEnabled())("sponsorship code consumed at signup (2.7)", () => {
  it("a fully covering code makes the signup SPONSORED, uses the code and takes paid places", async () => {
    const s = await setup();
    const sponsorship = await seedSponsorship({
      batchId: s.batch.id,
      eventId: s.event.id,
      code: "SP-FULLCOV2",
      totalAmount: 500,
      coversBasePrice: true,
      coveredAccessIds: [s.gala.id, s.tour.id],
    });

    const result = await signup(s, "  sp-fullcov2 ");

    expect(result.created).toBe(true);
    const registrationId = result.registration.id;
    const row = await readRegistration(registrationId);
    expect(row).toMatchObject({
      paymentStatus: "SPONSORED",
      totalAmount: 200,
      sponsorshipAmount: 200,
      paidAmount: 0,
      sponsorshipCode: "SP-FULLCOV2",
    });
    expect(row.paidAt).toBeInstanceOf(Date);
    expect(row.priceBreakdown).toMatchObject({
      subtotal: 200,
      sponsorshipTotal: 200,
      total: 0,
      sponsorships: [{ code: "SP-FULLCOV2", amount: 200, valid: true }],
    });
    expect(result.priceBreakdown).toMatchObject({ sponsorshipTotal: 200, total: 0 });

    expect((await readSponsorshipRow(sponsorship.id)).status).toBe("USED");
    const usages = await sponsorshipUsagesOf(sponsorship.id);
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ registrationId, amountApplied: 200, appliedBy: "PUBLIC" });

    expect(await counts(s.gala.id)).toEqual({ paid: 1, registered: 1 });
    expect(await counts(s.tour.id)).toEqual({ paid: 1, registered: 1 });

    const audits = await auditRowsOf("Sponsorship", sponsorship.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "LINK_TO_REGISTRATION", performedBy: "PUBLIC" });
    expect(await realtimeRowsOf("sponsorship.linked", sponsorship.id)).toHaveLength(1);
  });

  it("a partially covering code makes the signup PARTIAL with paid places for the covered item only", async () => {
    const s = await setup();
    const sponsorship = await seedSponsorship({
      batchId: s.batch.id,
      eventId: s.event.id,
      totalAmount: 500,
      coversBasePrice: false,
      coveredAccessIds: [s.gala.id],
    });

    const result = await signup(s, sponsorship.code);

    const row = await readRegistration(result.registration.id);
    expect(row).toMatchObject({ paymentStatus: "PARTIAL", totalAmount: 200, sponsorshipAmount: 120, paidAt: null });
    expect(row.priceBreakdown).toMatchObject({ sponsorshipTotal: 120, total: 80 });
    expect(await counts(s.gala.id)).toEqual({ paid: 1, registered: 1 });
    expect(await counts(s.tour.id)).toEqual({ paid: 0, registered: 1 });
    expect((await readSponsorshipRow(sponsorship.id)).status).toBe("USED");
  });

  it("a signup without a code stays PENDING and stores no code", async () => {
    const s = await setup();
    const result = await signup(s, undefined);
    const row = await readRegistration(result.registration.id);
    expect(row).toMatchObject({ paymentStatus: "PENDING", sponsorshipAmount: 0, sponsorshipCode: null });
  });

  it.each([
    ["unknown", async () => ({ code: "SP-NOSUCH22" })],
    [
      "cancelled",
      async (s: Setup) =>
        seedSponsorship({ batchId: s.batch.id, eventId: s.event.id, status: "CANCELLED", totalAmount: 500 }),
    ],
    [
      "of another event",
      async () => {
        const other = await setup();
        return seedSponsorship({ batchId: other.batch.id, eventId: other.event.id, totalAmount: 500 });
      },
    ],
  ] as Array<[string, (s: Setup) => Promise<{ code: string }>]>)(
    "refuses an %s code with 400 INVALID_SPONSORSHIP_CODE and writes nothing",
    async (_, makeCode) => {
    const s = await setup();
    const { code } = await makeCode(s);

    await expect(signup(s, code)).rejects.toMatchObject({
      code: ErrorCodes.INVALID_SPONSORSHIP_CODE,
      statusCode: 400,
    });
    expect(await registrationCount(s.event.id)).toBe(0);
    expect(await counts(s.gala.id)).toEqual({ paid: 0, registered: 0 });
    },
  );

  it.each([
    [
      "used",
      async (s: Setup) =>
        seedSponsorship({ batchId: s.batch.id, eventId: s.event.id, status: "USED", totalAmount: 500 }),
    ],
    [
      "reserved for a registration by a linked batch",
      async (s: Setup) => {
        const target = await seedRegistration({ eventId: s.event.id, formId: s.form.id });
        return seedSponsorship({
          batchId: s.batch.id,
          eventId: s.event.id,
          totalAmount: 500,
          targetRegistrationId: target.id,
        });
      },
    ],
    [
      "linked while still PENDING",
      async (s: Setup) => {
        const other = await seedRegistration({ eventId: s.event.id, formId: s.form.id });
        const sponsorship = await seedSponsorship({ batchId: s.batch.id, eventId: s.event.id, totalAmount: 500 });
        await seedSponsorshipUsage({
          sponsorshipId: sponsorship.id,
          registrationId: other.id,
          amountApplied: 0,
          appliedBy: "admin",
        });
        return sponsorship;
      },
    ],
    [
      "claimed by an earlier signup (stored untrimmed, lower-case)",
      async (s: Setup) => {
        const sponsorship = await seedSponsorship({ batchId: s.batch.id, eventId: s.event.id, totalAmount: 500 });
        await seedRegistration({
          eventId: s.event.id,
          formId: s.form.id,
          sponsorshipCode: ` ${sponsorship.code.toLowerCase()} `,
        });
        return sponsorship;
      },
    ],
  ])("refuses a %s code with 409 SPONSORSHIP_CODE_ALREADY_USED and writes nothing", async (_, makeSponsorship) => {
    const s = await setup();
    const sponsorship = await makeSponsorship(s);
    const before = await registrationCount(s.event.id);
    const usagesBefore = (await sponsorshipUsagesOf(sponsorship.id)).length;

    await expect(signup(s, sponsorship.code)).rejects.toMatchObject({
      code: ErrorCodes.SPONSORSHIP_CODE_ALREADY_USED,
      statusCode: 409,
    });
    expect(await registrationCount(s.event.id)).toBe(before);
    expect(await sponsorshipUsagesOf(sponsorship.id)).toHaveLength(usagesBefore);
    expect(await counts(s.gala.id)).toEqual({ paid: 0, registered: 0 });
  });

  it("a second signup with a consumed code gets 409", async () => {
    const s = await setup();
    const sponsorship = await seedSponsorship({
      batchId: s.batch.id,
      eventId: s.event.id,
      totalAmount: 500,
      coveredAccessIds: [s.gala.id, s.tour.id],
    });
    await signup(s, sponsorship.code);

    await expect(signup(s, sponsorship.code)).rejects.toMatchObject({
      code: ErrorCodes.SPONSORSHIP_CODE_ALREADY_USED,
      statusCode: 409,
    });
    expect(await sponsorshipUsagesOf(sponsorship.id)).toHaveLength(1);
    expect(await registrationCount(s.event.id)).toBe(1);
  });

  it("the price quote treats a code reserved for a registration as invalid", async () => {
    const s = await setup();
    const target = await seedRegistration({ eventId: s.event.id, formId: s.form.id });
    const reserved = await seedSponsorship({
      batchId: s.batch.id,
      eventId: s.event.id,
      totalAmount: 500,
      coveredAccessIds: [s.gala.id],
      targetRegistrationId: target.id,
    });
    const open = await seedSponsorship({
      batchId: s.batch.id,
      eventId: s.event.id,
      totalAmount: 500,
      coveredAccessIds: [s.gala.id],
    });

    const quote = (code: string) =>
      pricing.calculatePrice(s.event.id, {
        formData: {},
        selectedAccessItems: [{ accessId: s.gala.id, quantity: 1 }],
        sponsorshipCodes: [code],
      });
    expect((await quote(reserved.code)).sponsorships).toEqual([{ code: reserved.code, amount: 0, valid: false }]);
    expect((await quote(open.code)).sponsorships).toEqual([{ code: open.code, amount: 120, valid: true }]);
  });
});
