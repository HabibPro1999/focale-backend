import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PriceBreakdown } from "@app/contracts";
import {
  StoredJsonError,
  configureJsonbValidation,
  findRegistrationForMutation,
  findRegistrationWithFormEvent,
  getDb,
  getRegistrationByIdRow,
  getRegistrationCoverage,
  readSponsorshipTarget,
  settleRegistrationTxn,
  withLockingTxn,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent, seedForm, seedRegistration } from "../helpers/factories";

// `registrations.price_breakdown` typed as PriceBreakdown (plan 5.2b), on a
// migrated database, both engines. Every shape a registration writer has
// stored is read back unchanged under warn and enforce; a document no writer
// stores is read as stored under warn (as before typing) and refused under
// enforce, by the registration queries and by the settlement's own read.
describe.runIf(dbTestsEnabled())("db: registrations.price_breakdown read boundaries", () => {
  beforeEach(cleanupDatabase);
  afterEach(async () => {
    configureJsonbValidation(undefined);
    await cleanupDatabase();
  });

  const line = { accessId: "a1", name: "Workshop", unitPrice: 100, quantity: 1, subtotal: 100 };
  const priced: PriceBreakdown = {
    basePrice: 200,
    appliedRules: [],
    calculatedBasePrice: 200,
    accessItems: [line],
    accessTotal: 100,
    subtotal: 300,
    sponsorships: [],
    sponsorshipTotal: 0,
    total: 300,
    currency: "TND",
  };
  const stored: Record<string, PriceBreakdown> = {
    signup: { ...priced, accessItems: [{ ...line, status: "confirmed" }], droppedAccessItems: [] },
    "before dropped items": priced,
    deactivated: {
      ...priced,
      accessItems: [],
      accessTotal: 0,
      subtotal: 200,
      total: 200,
      droppedAccessItems: [{ ...line, status: "confirmed", reason: "deactivated" }],
    },
  };
  const unknownKey = { ...priced, legacyDiscount: 10 };

  async function seed(priceBreakdown: unknown) {
    const event = await seedEvent();
    const form = await seedForm({ eventId: event.id });
    return seedRegistration({
      eventId: event.id,
      formId: form.id,
      totalAmount: 300,
      priceBreakdown: priceBreakdown as never,
    });
  }

  async function reads(id: string) {
    return [
      (await getRegistrationByIdRow(id))?.priceBreakdown,
      (await findRegistrationWithFormEvent(id))?.priceBreakdown,
      (await getRegistrationCoverage(id))?.priceBreakdown,
      await withLockingTxn(async (tx) => (await findRegistrationForMutation(id, tx))?.priceBreakdown),
      await withLockingTxn(async (tx) => (await readSponsorshipTarget(tx, id))?.priceBreakdown),
    ];
  }

  describe.each(["warn", "enforce"] as const)("%s", (mode) => {
    it.each(Object.entries(stored))("reads the %s shape unchanged", async (_shape, priceBreakdown) => {
      configureJsonbValidation(mode);
      const registration = await seed(priceBreakdown);

      for (const read of await reads(registration.id)) expect(read).toEqual(priceBreakdown);
      const settled = await withLockingTxn((tx) => settleRegistrationTxn(tx, registration.id));
      expect(settled?.before.priceBreakdown).toEqual(priceBreakdown);
    });
  });

  it("warn: reads a document no writer stores exactly as stored", async () => {
    configureJsonbValidation("warn");
    const registration = await seed(unknownKey);

    for (const read of await reads(registration.id)) expect(read).toEqual(unknownKey);
    const settled = await withLockingTxn((tx) => settleRegistrationTxn(tx, registration.id));
    expect(settled?.before.priceBreakdown).toEqual(unknownKey);
  });

  it("enforce: refuses it, naming the column, row and path, and the settlement writes nothing", async () => {
    configureJsonbValidation("enforce");
    const registration = await seed(unknownKey);
    const refusal = `Stored JSON registrations.price_breakdown (id ${registration.id}) does not match its schema: legacyDiscount (stripped_key)`;

    await expect(getRegistrationByIdRow(registration.id)).rejects.toThrow(refusal);
    await expect(findRegistrationWithFormEvent(registration.id)).rejects.toThrow(StoredJsonError);
    await expect(getRegistrationCoverage(registration.id)).rejects.toThrow(StoredJsonError);
    await expect(
      withLockingTxn((tx) => settleRegistrationTxn(tx, registration.id, { paymentStatus: "PAID", paidAmount: 300 })),
    ).rejects.toThrow(refusal);

    configureJsonbValidation("warn");
    const after = await getRegistrationByIdRow(registration.id, getDb());
    expect(after).toMatchObject({ paymentStatus: "PENDING", paidAmount: 0, priceBreakdown: unknownKey });
  });
});
