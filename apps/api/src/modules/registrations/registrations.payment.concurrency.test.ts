import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "@app/contracts";
import {
  findRegistrationForMutation,
  getAccessPaidCount,
  getAccessRegisteredCount,
  lockRegistrationForUpdate,
  withTxn,
} from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";

// In-memory storage for the payment-proof path; every other dependency is real.
const storage = vi.hoisted(() => ({ objects: new Map<string, Buffer>() }));
vi.mock("@app/integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getStorageProvider: () => ({
    uploadPrivate: async (buffer: Buffer, key: string) => {
      storage.objects.set(key, buffer);
      return key;
    },
    delete: async (key: string) => {
      storage.objects.delete(key);
    },
  }),
}));

import {
  seedEvent,
  seedEventAccess,
  seedForm,
  seedRegistration,
} from "../../../../../packages/db/tests/helpers/factories";
import type { Config } from "../../core/config";
import { AccessService } from "../access/access.service";
import { PricingService } from "../pricing/pricing.service";
import { RegistrationsService } from "./registrations.service";
import { RegistrationSideEffects } from "./registrations.side-effects";
import { PaymentProofService } from "./registrations.payment-proof.service";
import { RegistrationRepricer } from "./registrations.repricer";

// Plan 2.6b: the payment status writers (confirmPayment, payment-proof upload,
// payment-method selection, admin edits) lock the registration first and decide
// from the row re-read under the lock, so a concurrent confirmation can no
// longer be overwritten and paid capacity always matches the stored state.

const access = new AccessService();
const sideEffects = new RegistrationSideEffects(access);
const service = new RegistrationsService(
  access,
  new PricingService(),
  { publicLinkAllowedOrigins: ["https://events.example.com"] } as Config,
  sideEffects,
);
const proofs = new PaymentProofService(sideEffects);
const repricer = new RegistrationRepricer(access, new PricingService(), sideEffects);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

type AccessRow = { id: string; price: number };

function breakdown(items: AccessRow[], base = 0) {
  const accessItems = items.map((item) => ({
    accessId: item.id,
    name: "Access",
    unitPrice: item.price,
    quantity: 1,
    subtotal: item.price,
  }));
  const accessTotal = accessItems.reduce((sum, item) => sum + item.subtotal, 0);
  const subtotal = base + accessTotal;
  return {
    basePrice: base,
    appliedRules: [],
    calculatedBasePrice: base,
    accessItems,
    accessTotal,
    subtotal,
    sponsorships: [],
    sponsorshipTotal: 0,
    total: subtotal,
    currency: "TND",
    droppedAccessItems: [],
  };
}

async function eventWithForm() {
  const event = await seedEvent({ status: "OPEN", endDate: new Date("2099-01-01T00:00:00.000Z") });
  const form = await seedForm({ eventId: event.id });
  return { event, form };
}

async function seedPending(
  eventId: string,
  formId: string,
  options: { items?: AccessRow[]; base?: number; status?: "PENDING" | "VERIFYING" } = {},
) {
  const items = options.items ?? [];
  const pb = breakdown(items, options.base ?? 0);
  return seedRegistration({
    eventId,
    formId,
    paymentStatus: options.status ?? "PENDING",
    totalAmount: pb.subtotal,
    baseAmount: pb.calculatedBasePrice,
    accessAmount: pb.accessTotal,
    priceBreakdown: pb,
    accessTypeIds: items.map((item) => item.id),
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

/** A transaction holding the registration's row lock until `release()`. */
async function holdRegistrationLock(registrationId: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const done = withTxn(async (tx) => {
    await lockRegistrationForUpdate(tx, registrationId);
    locked();
    await released;
  });
  await Promise.race([isLocked, done]);
  return { release, done };
}

/** True when `promise` settles within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true, () => true), sleep(ms).then(() => false)]);
}

/**
 * Start `first`, wait until it is blocked behind a held lock on the
 * registration, then start `second` and wait again, so both have queued in
 * that order before the lock is released.
 */
async function queueBehindLock<A, B>(registrationId: string, first: () => Promise<A>, second: () => Promise<B>) {
  const holder = await holdRegistrationLock(registrationId);
  try {
    const a = first();
    expect(await settlesWithin(a, 400)).toBe(false);
    const b = second();
    expect(await settlesWithin(b, 400)).toBe(false);
    holder.release();
    await holder.done;
    return await Promise.allSettled([a, b]);
  } finally {
    holder.release();
    await holder.done.catch(() => undefined);
  }
}

describe.runIf(dbTestsEnabled())("registration payment writers under concurrency", () => {
  it("serializes a confirmation with an admin access edit: no lost update", async () => {
    const { event, form } = await eventWithForm();
    const x = await seedEventAccess({ eventId: event.id, name: "Workshop X", price: 100, registeredCount: 1 });
    const y = await seedEventAccess({ eventId: event.id, name: "Workshop Y", price: 100 });
    const registration = await seedPending(event.id, form.id, { items: [x] });

    const results = await queueBehindLock(
      registration.id,
      () => service.confirmPayment(registration.id, { paymentStatus: "PAID" }, "admin-1"),
      () =>
        repricer.adminEditRegistration(
          event.id,
          registration.id,
          { accessSelections: [{ accessId: y.id, quantity: 1 }] } as never,
          "admin-1",
        ),
    );

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const row = await readRegistration(registration.id);
    expect(row).toMatchObject({ paymentStatus: "PAID", paidAmount: 100, totalAmount: 100, accessTypeIds: [y.id] });
    // The paid place follows the access item the registration holds now.
    expect(await counts(x.id)).toEqual({ paid: 0, registered: 0 });
    expect(await counts(y.id)).toEqual({ paid: 1, registered: 1 });
  });

  it("keeps a confirmation when a payment-proof upload queued behind it", async () => {
    const { event, form } = await eventWithForm();
    const registration = await seedPending(event.id, form.id, { base: 100 });

    const [confirm, proof] = await queueBehindLock(
      registration.id,
      () => service.confirmPayment(registration.id, { paymentStatus: "PAID" }, "admin-1"),
      () =>
        proofs.uploadPaymentProof(registration.id, {
          buffer: PDF,
          filename: "proof.pdf",
          mimetype: "application/pdf",
        }),
    );

    expect(confirm.status).toBe("fulfilled");
    const row = await readRegistration(registration.id);
    expect(row).toMatchObject({ paymentStatus: "PAID", paidAmount: 100 });
    if (proof.status === "rejected") {
      expect(proof.reason).toMatchObject({ code: ErrorCodes.INVALID_PAYMENT_TRANSITION });
      // The rejected upload leaves no object behind.
      const keys = [...storage.objects.keys()].filter((key) => key.includes(registration.id));
      expect(keys).toEqual([]);
    } else {
      expect(row.paymentProofUrl).toBe(proof.value.fileUrl);
    }
  });

  it("keeps a confirmation when a payment-method selection queued behind it", async () => {
    const { event, form } = await eventWithForm();
    const x = await seedEventAccess({ eventId: event.id, name: "Workshop X", price: 100, registeredCount: 1 });
    const registration = await seedPending(event.id, form.id, { items: [x] });

    const [confirm, method] = await queueBehindLock(
      registration.id,
      () => service.confirmPayment(registration.id, { paymentStatus: "PAID" }, "admin-1"),
      () => service.selectPaymentMethod(registration.id, { paymentMethod: "CASH" } as never),
    );

    expect(confirm.status).toBe("fulfilled");
    if (method.status === "rejected") {
      expect(method.reason).toMatchObject({ code: ErrorCodes.REGISTRATION_INVALID_STATUS });
    }
    expect(await readRegistration(registration.id)).toMatchObject({ paymentStatus: "PAID", paidAmount: 100 });
    expect((await counts(x.id)).paid).toBe(1);
  });

  it("rejects a payment-method selection on a VERIFYING registration", async () => {
    const { event, form } = await eventWithForm();
    const registration = await seedPending(event.id, form.id, { base: 100, status: "VERIFYING" });

    await expect(
      service.selectPaymentMethod(registration.id, { paymentMethod: "CASH" } as never),
    ).rejects.toMatchObject({ code: ErrorCodes.REGISTRATION_INVALID_STATUS });
    expect(await readRegistration(registration.id)).toMatchObject({ paymentStatus: "VERIFYING", paymentMethod: null });
  });

  it("gives the last paid place to one of two concurrent confirmations", async () => {
    const { event, form } = await eventWithForm();
    const x = await seedEventAccess({
      eventId: event.id,
      name: "Workshop X",
      price: 100,
      maxCapacity: 1,
      registeredCount: 2,
    });
    const first = await seedPending(event.id, form.id, { items: [x] });
    const second = await seedPending(event.id, form.id, { items: [x] });

    const results = await Promise.allSettled([
      service.confirmPayment(first.id, { paymentStatus: "PAID" }, "admin-1"),
      service.confirmPayment(second.id, { paymentStatus: "PAID" }, "admin-2"),
    ]);

    // A lost race is a 409 (or the item was dropped first), never a 5xx.
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ code: ErrorCodes.ACCESS_CAPACITY_EXCEEDED, statusCode: 409 });
      }
    }
    const rows = await Promise.all([readRegistration(first.id), readRegistration(second.id)]);
    const holders = rows.filter((row) => row.paymentStatus === "PAID" && (row.accessTypeIds ?? []).includes(x.id));
    expect(holders).toHaveLength(1);
    expect((await counts(x.id)).paid).toBe(1);
    for (const row of rows.filter((candidate) => !holders.includes(candidate))) {
      // The other one either lost the item to capacity or was refused.
      expect(
        (row.droppedAccessIds ?? []).includes(x.id) || row.paymentStatus === "PENDING",
      ).toBe(true);
    }
  });
});
