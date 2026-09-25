import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  clients,
  forms,
  getDb,
  networkingStore,
  registrations,
  syncNetworkingEvent,
} from "@app/db";
import { NetworkingConfigSchema } from "@app/contracts";
import { dbTestsEnabled } from "@app/db/testing";
import { NetworkingService } from "./networking.service";
import { networkingOtpHash } from "./networking.security";

const enabled = dbTestsEnabled();
const service = new NetworkingService();
const ids = { client: randomUUID(), event: randomUUID(), other: randomUUID(), form: randomUUID() };
const email = `otp-${ids.event}@example.invalid`;
const code = "424242";
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

async function challenge(values: {
  eventId?: string;
  email?: string;
  attempts?: number;
  createdAt?: Date;
  consumed?: boolean;
  verified?: boolean;
  code?: string;
}) {
  const eventId = values.eventId ?? ids.event;
  const address = values.email ?? email;
  const createdAt = values.createdAt ?? new Date();
  return networkingStore().insert("challenges", {
    id: randomUUID(),
    eventId,
    email: address,
    codeHash: networkingOtpHash(eventId, address, values.code ?? code),
    expiresAt: new Date(createdAt.getTime() + 10 * 60_000),
    attempts: values.attempts ?? 0,
    consumedAt: values.consumed || values.verified ? createdAt : null,
    verifiedAt: values.verified ? createdAt : null,
    createdAt,
  });
}
const failed = () =>
  networkingStore().failedOtpAttempts(ids.event, email, minutesAgo(15), minutesAgo(24 * 60));

describe.runIf(enabled)("networking OTP failed-attempt limits (real database)", () => {
  beforeAll(async () => {
    process.env.NETWORKING_TOKEN_SECRET = "test-networking-secret-at-least-32-characters";
    await getDb().insert(clients).values({
      id: ids.client,
      name: "Networking OTP limit tests",
      enabledModules: ["networking", "registrations", "emails"],
    });
    const config = NetworkingConfigSchema.parse({ enabled: true, approvalMode: "AUTOMATIC", timezone: "UTC" });
    for (const id of [ids.event, ids.other]) {
      await networkingStore().insert("events", {
        id,
        clientId: ids.client,
        name: "Networking OTP fixture",
        slug: id,
        status: "OPEN",
        startDate: new Date("2031-04-05T00:00Z"),
        endDate: new Date("2031-04-06T00:00Z"),
      });
      await networkingStore().insert("configs", { eventId: id, config });
    }
    await getDb().insert(forms).values({ id: ids.form, eventId: ids.event, name: "Registration", schema: { steps: [] } });
    await getDb().insert(registrations).values({
      id: randomUUID(),
      eventId: ids.event,
      formId: ids.form,
      email,
      firstName: "Otp",
      lastName: "Limit",
      paymentStatus: "PAID",
      totalAmount: 0,
      priceBreakdown: {},
      networkingOptIn: true,
      formData: {},
    });
    await syncNetworkingEvent(ids.event);
  }, 30_000);

  beforeEach(async () => {
    for (const eventId of [ids.event, ids.other]) await networkingStore().remove("challenges", { eventId });
  });

  it("sums failed attempts per event and email across challenges, excluding the verified attempt", async () => {
    await challenge({ attempts: 3, createdAt: minutesAgo(5), consumed: true });
    await challenge({ attempts: 4, createdAt: minutesAgo(3), verified: true });
    await challenge({ attempts: 5, createdAt: minutesAgo(20), consumed: true });
    await challenge({ attempts: 5, createdAt: minutesAgo(25 * 60) });
    await challenge({ attempts: 5, email: `other-${email}` });
    await challenge({ attempts: 5, eventId: ids.other });
    expect(await failed()).toEqual({ recent: 3 + 3, daily: 3 + 3 + 5 });
  });

  it("returns 429 before comparing the code once 10 attempts failed in 15 minutes", async () => {
    await challenge({ attempts: 5, createdAt: minutesAgo(12), consumed: true });
    await challenge({ attempts: 5, createdAt: minutesAgo(6), consumed: true });
    const fresh = await challenge({});
    await expect(service.verifyCode(ids.event, fresh.id, code)).rejects.toMatchObject({
      status: 429,
      response: { code: "NETWORKING_RATE_LIMITED" },
    });
    const row = await networkingStore().one("challenges", { id: fresh.id });
    expect(row).toMatchObject({ attempts: 0, consumedAt: null, verifiedAt: null });
    expect(await networkingStore().all("sessions", { eventId: ids.event })).toHaveLength(0);
    // Challenges older than the 15-minute window stop counting toward the short limit.
    await networkingStore().update("challenges", { eventId: ids.event, attempts: 5 }, { createdAt: minutesAgo(16) });
    await expect(service.verifyCode(ids.event, fresh.id, "000000")).rejects.toMatchObject({ status: 401 });
  });

  it("returns 429 once 30 attempts failed in 24 hours", async () => {
    for (let hours = 1; hours <= 6; hours++)
      await challenge({ attempts: 5, createdAt: minutesAgo(hours * 60), consumed: true });
    const fresh = await challenge({});
    await expect(service.verifyCode(ids.event, fresh.id, code)).rejects.toMatchObject({ status: 429 });
    expect(await networkingStore().one("challenges", { id: fresh.id })).toMatchObject({ attempts: 0 });
  });

  it("marks a successful verification so it never counts as a failure", async () => {
    const fresh = await challenge({});
    for (const wrong of ["000000", "111111"])
      await expect(service.verifyCode(ids.event, fresh.id, wrong)).rejects.toMatchObject({ status: 401 });
    const issued = await service.verifyCode(ids.event, fresh.id, code);
    expect(issued.token).toEqual(expect.any(String));
    expect(issued).not.toHaveProperty("session");
    const row = await networkingStore().one("challenges", { id: fresh.id });
    expect(row).toMatchObject({ attempts: 3 });
    expect(row?.verifiedAt).toBeInstanceOf(Date);
    expect(row?.consumedAt).toBeInstanceOf(Date);
    expect(await failed()).toEqual({ recent: 2, daily: 2 });
    await expect(service.participant(ids.event, `Bearer ${issued.token}`)).resolves.toMatchObject({
      profile: { email },
    });
  });
});
