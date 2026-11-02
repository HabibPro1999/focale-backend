import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, registrations, settleRegistrationTxn, withLockingTxn } from "@app/db";
import { withBreakdownMoney } from "@app/shared";
import { dbTestsEnabled } from "@app/db/testing";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent, seedForm, seedRegistration } from "../helpers/factories";

describe.runIf(dbTestsEnabled())("fractional option charge settlement", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);
  it("persists an option charge and marks an exact fractional payment paid", async () => {
    const event = await seedEvent();
    const form = await seedForm({ eventId: event.id });
    const priceBreakdown = withBreakdownMoney({ basePrice: 0.1, calculatedBasePrice: 0.1,
      appliedRules: [], accessItems: [], accessTotal: 0, currency: "TND",
      optionModifiers: [{ fieldId: "extras", optionId: "lunch", label: "Lunch", amount: 0.2 }],
      optionModifiersTotal: 0.2, subtotal: 0.3, sponsorships: [], sponsorshipTotal: 0, total: 0.3 });
    const reg = await seedRegistration({ eventId: event.id, formId: form.id, totalAmount: 0.3,
      baseAmount: 0.1, paidAmount: 0, sponsorshipAmount: 0, paymentStatus: "PENDING", priceBreakdown });
    await withLockingTxn((tx) => settleRegistrationTxn(tx, reg.id, { paidAmount: 0.3, priceBreakdown }));
    const [saved] = await getDb().select().from(registrations).where(eq(registrations.id, reg.id));
    expect(saved).toMatchObject({ totalAmount: 0.3, paidAmount: 0.3, baseAmount: 0.1, paymentStatus: "PAID",
      priceBreakdown: { optionModifiersTotal: 0.2, money: { amountsMinor: { total: 300 } } } });
  });
});
