import { describe, expect, it, vi } from "vitest";
import {
  checkSettlementInvariants,
  findRegistrationForMutation,
  getAccessPaidCount,
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
} from "@app/db/testing/fixtures";
import { AccessService } from "../access/access.service";
import { PaymentProofService } from "./registrations.payment-proof.service";
import { RegistrationPaymentsService } from "./registrations.payments.service";
import { RegistrationSideEffects } from "./registrations.side-effects";

// Only storage is fake; settlement, sponsorships, counters and audits use the DB.
vi.mock("@app/integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getStorageProvider: () => ({
    uploadPrivate: async (_buffer: Buffer, key: string) => key,
    delete: async () => undefined,
  }),
}));

const access = new AccessService();
const sideEffects = new RegistrationSideEffects(access);
const payments = new RegistrationPaymentsService(access, sideEffects);
const proofs = new PaymentProofService(sideEffects);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

async function setup() {
  const event = await seedEvent({ status: "OPEN", endDate: new Date("2099-01-01"), registeredCount: 1 });
  const form = await seedForm({
    eventId: event.id,
    schema: { steps: [{ id: "details", title: "Details", fields: [] }] },
  });
  const covered = await seedEventAccess({
    eventId: event.id, name: "Sponsored", price: 60, maxCapacity: 1, registeredCount: 1, paidCount: 1,
  });
  const uncovered = await seedEventAccess({
    eventId: event.id, name: "Remaining", price: 40, maxCapacity: 1, registeredCount: 1, paidCount: 0,
  });
  const batch = await seedSponsorshipBatch({ eventId: event.id, formId: form.id });
  const sponsorship = await seedSponsorship({
    batchId: batch.id, eventId: event.id, status: "USED", totalAmount: 60,
    coversBasePrice: false, coveredAccessIds: [covered.id],
  });
  const registration = await seedRegistration({
    eventId: event.id, formId: form.id, paymentStatus: "PARTIAL",
    totalAmount: 100, accessAmount: 100, sponsorshipAmount: 60, paidAmount: 10,
    sponsorshipCode: sponsorship.code, accessTypeIds: [covered.id, uncovered.id],
    priceBreakdown: {
      basePrice: 0, calculatedBasePrice: 0, appliedRules: [],
      accessItems: [covered, uncovered].map((item) => ({
        accessId: item.id, name: item.name, unitPrice: item.price, quantity: 1, subtotal: item.price,
      })),
      accessTotal: 100, subtotal: 100,
      sponsorships: [{ code: sponsorship.code, amount: 60, valid: true }],
      sponsorshipTotal: 60, total: 40, currency: "TND",
    },
  });
  await seedSponsorshipUsage({
    sponsorshipId: sponsorship.id, registrationId: registration.id, amountApplied: 60, appliedBy: "PUBLIC",
  });
  return { event, covered, uncovered, registration };
}

async function read(id: string) {
  return withTxn((tx) => findRegistrationForMutation(id, tx));
}

function upload(id: string) {
  return proofs.uploadPaymentProof(id, { buffer: PDF, filename: "proof.pdf", mimetype: "application/pdf" });
}

async function paidCounts(f: Awaited<ReturnType<typeof setup>>) {
  return [
    (await getAccessPaidCount(f.covered.id))!.paidCount,
    (await getAccessPaidCount(f.uncovered.id))!.paidCount,
  ];
}

describe.runIf(dbTestsEnabled())("public payment of a PARTIAL balance", () => {
  it("selects cash without losing the partial status, amounts or sponsored seat", async () => {
    const f = await setup();
    await payments.selectPaymentMethod(f.registration.id, { paymentMethod: "CASH" });
    const row = await read(f.registration.id);
    expect(row).toMatchObject({
      paymentStatus: "PARTIAL", paymentMethod: "CASH", paidAmount: 10,
      totalAmount: 100, sponsorshipAmount: 60, priceBreakdown: f.registration.priceBreakdown,
    });
    expect(await paidCounts(f)).toEqual([1, 0]);
    expect((await checkSettlementInvariants({ eventId: f.event.id })).ok).toBe(true);
  });

  it("keeps sponsored capacity through proof review and confirms only the remaining seats", async () => {
    const f = await setup();
    const result = await upload(f.registration.id);
    expect(await read(f.registration.id)).toMatchObject({
      paymentStatus: "VERIFYING", paymentMethod: "BANK_TRANSFER", paymentProofUrl: result.fileUrl,
      paidAmount: 10, totalAmount: 100, sponsorshipAmount: 60,
    });
    expect(await paidCounts(f)).toEqual([1, 0]);
    expect((await checkSettlementInvariants({ eventId: f.event.id })).ok).toBe(true);

    // An admin can leave the balance partially paid, and the participant can submit again.
    await payments.confirmPayment(f.registration.id, { paymentStatus: "PARTIAL", paidAmount: 20 }, "admin-1");
    expect(await paidCounts(f)).toEqual([1, 0]);
    await upload(f.registration.id);
    await payments.confirmPayment(f.registration.id, { paymentStatus: "PAID" }, "admin-1");
    expect(await read(f.registration.id)).toMatchObject({
      paymentStatus: "PAID", paidAmount: 40, totalAmount: 100, sponsorshipAmount: 60,
    });
    // The sponsored seat is already full: charging it twice would reject confirmation.
    expect(await paidCounts(f)).toEqual([1, 1]);
    expect((await checkSettlementInvariants({ eventId: f.event.id })).ok).toBe(true);
  });

  it("releases the sponsored seat when an admin refunds a balance under review", async () => {
    const f = await setup();
    await upload(f.registration.id);
    await payments.updateRegistration(f.registration.id, { paymentStatus: "REFUNDED" }, "admin-1");
    expect(await read(f.registration.id)).toMatchObject({ paymentStatus: "REFUNDED", paidAmount: 10 });
    expect(await paidCounts(f)).toEqual([0, 0]);
    expect((await checkSettlementInvariants({ eventId: f.event.id })).ok).toBe(true);
  });
});
