import { describe, expect, it, vi } from "vitest";

// Plan 4.8: the networking projection is out of the registration
// transactions. Every sync throws in this file, as if networking were broken:
// a payment confirmation must still commit, leaving a
// `networking.registration.sync` row for the worker, whose failure is retried
// by the outbox without touching the payment.
const sync = vi.hoisted(() => ({
  calls: [] as string[],
}));
vi.mock("../../../../../packages/db/src/queries/networking", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  syncNetworkingRegistration: async (registrationId: string) => {
    sync.calls.push(registrationId);
    throw new Error("networking projection unavailable");
  },
}));

import { NetworkingConfigSchema } from "@app/contracts";
import {
  NETWORKING_REGISTRATION_SYNC_OUTBOX_TYPE,
  findRegistrationForMutation,
  getDb,
  handleNetworkingRegistrationSyncOutbox,
  networkingConfigs,
  networkingProfiles,
  outboxEvents,
  processOutboxEvents,
  withTxn,
} from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { seedEvent, seedForm, seedRegistration } from "../../../../../packages/db/tests/helpers/factories";
import { AccessService } from "../access/access.service";
import { RegistrationPaymentsService } from "./registrations.payments.service";
import { RegistrationSideEffects } from "./registrations.side-effects";

const access = new AccessService();
const payments = new RegistrationPaymentsService(access, new RegistrationSideEffects(access));

function breakdown(total: number) {
  return {
    basePrice: total,
    appliedRules: [],
    calculatedBasePrice: total,
    accessItems: [],
    accessTotal: 0,
    subtotal: total,
    sponsorships: [],
    sponsorshipTotal: 0,
    total,
    currency: "TND",
    droppedAccessItems: [],
  };
}

// apps/api has no drizzle-orm dependency: the file's own database is small, so filter here.
async function syncRows() {
  const rows = await getDb().select().from(outboxEvents);
  return rows.filter((row) => row.type === NETWORKING_REGISTRATION_SYNC_OUTBOX_TYPE);
}

describe.runIf(dbTestsEnabled())("payment confirmation and the networking projection (4.8)", () => {
  it("commits the payment even when networking sync throws; the sync is retried from the outbox", async () => {
    const event = await seedEvent({ status: "OPEN", endDate: new Date("2099-01-01T00:00:00.000Z") });
    const form = await seedForm({ eventId: event.id });
    await getDb()
      .insert(networkingConfigs)
      .values({ eventId: event.id, config: NetworkingConfigSchema.parse({ enabled: true, approvalMode: "AUTOMATIC" }) });
    const pb = breakdown(100);
    const registration = await seedRegistration({
      eventId: event.id,
      formId: form.id,
      paymentStatus: "PENDING",
      totalAmount: pb.subtotal,
      baseAmount: pb.calculatedBasePrice,
      priceBreakdown: pb,
      networkingOptIn: true,
    });

    const confirmed = await payments.confirmPayment(registration.id, { paymentStatus: "PAID" }, "admin-1");

    expect(confirmed).toMatchObject({ id: registration.id, paymentStatus: "PAID" });
    const stored = await withTxn((tx) => findRegistrationForMutation(registration.id, tx));
    expect(stored).toMatchObject({ paymentStatus: "PAID", paidAmount: 100 });
    // Nothing ran the sync in the payment transaction; it left an outbox row (IDs only).
    expect(sync.calls).toEqual([]);
    const [row] = await syncRows();
    expect(row).toMatchObject({ status: "PENDING", eventId: event.id, payload: { registrationId: registration.id } });

    // The worker runs it: the sync throws, the row is retried later, the payment stands.
    await vi.waitFor(
      async () => {
        const result = await processOutboxEvents(20, {
          workerId: "payment-networking-sync-test",
          scope: "background",
          handlers: {
            [NETWORKING_REGISTRATION_SYNC_OUTBOX_TYPE]: handleNetworkingRegistrationSyncOutbox,
            // The payment-confirmed email is not under test.
            "email.triggered": () => "skipped",
          },
        });
        expect(result.failed).toBe(1);
      },
      { timeout: 10_000, interval: 50 },
    );
    expect(sync.calls).toEqual([registration.id]);
    const [failed] = await syncRows();
    expect(failed).toMatchObject({ status: "FAILED", attemptCount: 1, errorMessage: "networking projection unavailable" });
    expect(failed!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await withTxn((tx) => findRegistrationForMutation(registration.id, tx))).toMatchObject({ paymentStatus: "PAID" });
    const profiles = await getDb().select().from(networkingProfiles);
    expect(profiles.filter((profile) => profile.registrationId === registration.id)).toEqual([]);
  });
});
