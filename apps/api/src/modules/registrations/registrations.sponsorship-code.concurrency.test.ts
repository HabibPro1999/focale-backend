import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { ErrorCodes } from "@app/contracts";
import {
  getAccessPaidCount,
  getAccessRegisteredCount,
  lockSponsorshipForUpdate,
  withTxn,
} from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import {
  seedEvent,
  seedEventAccess,
  seedForm,
  seedSponsorship,
  seedSponsorshipBatch,
} from "../../../../../packages/db/tests/helpers/factories";
import {
  readSponsorshipRow,
  registrationIdsOfEvent,
  sponsorshipUsagesOf,
} from "../../../../../packages/db/tests/helpers/sponsorship-inspect";
import type { Config } from "../../core/config";
import { AccessService } from "../access/access.service";
import { PricingService } from "../pricing/pricing.service";
import { RegistrationsService } from "./registrations.service";

// Plan 2.7: two signups racing for one sponsorship code. The create
// transaction locks the code's sponsorship first, so the second signup waits
// for the first and then sees the code used: exactly one 201, one 409.

const service = new RegistrationsService(
  new AccessService(),
  new PricingService(),
  { publicLinkAllowedOrigins: ["https://events.example.com"] } as Config,
);

async function setup() {
  const event = await seedEvent({ status: "OPEN", endDate: new Date("2099-01-01T00:00:00.000Z") });
  const form = await seedForm({ eventId: event.id });
  const gala = await seedEventAccess({ eventId: event.id, name: "Gala", price: 150, type: "ADDON" });
  const batch = await seedSponsorshipBatch({ eventId: event.id, formId: form.id });
  const sponsorship = await seedSponsorship({
    batchId: batch.id,
    eventId: event.id,
    totalAmount: 500,
    coversBasePrice: true,
    coveredAccessIds: [gala.id],
  });
  return { event, form, gala, sponsorship };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function signup(s: Setup, email: string) {
  return service.createPublicRegistration(s.form.id, {
    formData: {},
    email,
    accessSelections: [{ accessId: s.gala.id, quantity: 1 }],
    sponsorshipCode: s.sponsorship.code.toLowerCase(),
  } as never);
}

/** A transaction holding the sponsorship's row lock until `release()`. */
async function holdSponsorshipLock(sponsorshipId: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const done = withTxn(async (tx) => {
    await lockSponsorshipForUpdate(tx, sponsorshipId);
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

async function expectOneWinner(s: Setup, results: PromiseSettledResult<{ created: boolean; registration: { id: string } }>[]) {
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(rejected[0].reason).toMatchObject({ code: ErrorCodes.SPONSORSHIP_CODE_ALREADY_USED, statusCode: 409 });

  const winner = (fulfilled[0] as PromiseFulfilledResult<{ created: boolean; registration: { id: string } }>).value;
  expect(winner.created).toBe(true);
  expect(await registrationIdsOfEvent(s.event.id)).toEqual([winner.registration.id]);
  const usages = await sponsorshipUsagesOf(s.sponsorship.id);
  expect(usages.map((u) => u.registrationId)).toEqual([winner.registration.id]);
  expect((await readSponsorshipRow(s.sponsorship.id)).status).toBe("USED");
  // The loser rolled back its registered place; the winner holds a paid one.
  expect((await getAccessRegisteredCount(s.gala.id))!.registeredCount).toBe(1);
  expect((await getAccessPaidCount(s.gala.id))!.paidCount).toBe(1);
}

describe.runIf(dbTestsEnabled())("sponsorship code consumed at signup under concurrency (2.7)", () => {
  it("two signups queued on one code: one is created, the other gets 409", async () => {
    const s = await setup();
    const holder = await holdSponsorshipLock(s.sponsorship.id);
    try {
      const first = signup(s, "first@example.test");
      expect(await settlesWithin(first, 400)).toBe(false);
      const second = signup(s, "second@example.test");
      expect(await settlesWithin(second, 400)).toBe(false);
      holder.release();
      await holder.done;
      await expectOneWinner(s, await Promise.allSettled([first, second]));
    } finally {
      holder.release();
      await holder.done.catch(() => undefined);
    }
  });

  it("two signups started together on one code: one is created, the other gets 409", async () => {
    const s = await setup();
    await expectOneWinner(
      s,
      await Promise.allSettled([signup(s, "left@example.test"), signup(s, "right@example.test")]),
    );
  });
});
