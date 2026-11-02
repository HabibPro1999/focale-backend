import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { getDb, registrations, sponsorships, sponsorshipUsages, withLockingTxn, linkSponsorshipToRegistrationTxn } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { cleanupDatabase } from "../../../../../packages/db/tests/helpers/cleanup";
import { seedClient, seedEvent, seedForm, seedSponsorship, seedSponsorshipBatch, seedRegistration, seedUser } from "../../../../../packages/db/tests/helpers/factories";
import { SponsorshipsAdminService } from "./sponsorships.admin.service";
import type { AccessService } from "../access/access.service";
const service = new SponsorshipsAdminService({ handleCapacityReached: vi.fn() } as unknown as AccessService);
async function fixture() {
  const client = await seedClient({ enabledModules: ["sponsorships"] });
  const event = await seedEvent({ clientId: client.id }); const form = await seedForm({ eventId: event.id });
  const batch = await seedSponsorshipBatch({ eventId: event.id, formId: form.id });
  const sponsor = await seedSponsorship({ eventId: event.id, batchId: batch.id, totalAmount: 100 });
  const user = await seedUser();
  const reg = await seedRegistration({ eventId: event.id, formId: form.id, totalAmount: 100, baseAmount: 100,
    priceBreakdown: { basePrice: 100, calculatedBasePrice: 100, appliedRules: [], accessItems: [], accessTotal: 0,
      subtotal: 100, sponsorships: [], sponsorshipTotal: 0, total: 100, currency: "TND", droppedAccessItems: [] } });
  await withLockingTxn(tx => linkSponsorshipToRegistrationTxn(tx, { sponsorshipId: sponsor.id, registrationId: reg.id, appliedBy: user.id }));
  return { sponsor, reg, user };
}
describe.runIf(dbTestsEnabled())("sponsorship cancellation undo", () => {
  beforeEach(cleanupDatabase); afterEach(cleanupDatabase);
  it("restores former links, settlement and USED status atomically; a retry is harmless", async () => {
    const { sponsor, user } = await fixture();
    await service.cancelSponsorship(sponsor.id, user.id);
    expect(await getDb().select().from(sponsorshipUsages)).toHaveLength(0);
    await service.restoreSponsorship(sponsor.id, user.id);
    await service.restoreSponsorship(sponsor.id, user.id);
    expect(await getDb().select().from(sponsorshipUsages)).toHaveLength(1);
    expect((await getDb().select().from(registrations))[0]).toMatchObject({ paymentStatus: "SPONSORED", sponsorshipAmount: 100 });
    expect((await getDb().select().from(sponsorships))[0].status).toBe("USED");
  });
  it("refuses undo after intervening registration changes and leaves cancellation intact", async () => {
    const { sponsor, user } = await fixture();
    await service.cancelSponsorship(sponsor.id, user.id);
    await getDb().update(registrations).set({ paidAmount: 50 });
    await expect(service.restoreSponsorship(sponsor.id, user.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(await getDb().select().from(sponsorshipUsages)).toHaveLength(0);
    expect((await getDb().select().from(sponsorships))[0].status).toBe("CANCELLED");
  });
});
