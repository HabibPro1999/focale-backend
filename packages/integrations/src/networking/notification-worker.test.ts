import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkingDeliveryRow } from "@app/db";
const db = vi.hoisted(() => ({
  claimNetworkingDeliveries: vi.fn(), refreshNetworkingDeliveryLease: vi.fn(),
  networkingDeliveryContext: vi.fn(), networkingDigestContexts: vi.fn(), localizeNetworkingNotification: vi.fn(),
  updateNetworkingDelivery: vi.fn(), beginNetworkingEmailLog: vi.fn(), markNetworkingEmailAttempt: vi.fn(),
  finishNetworkingEmailLog: vi.fn(), deleteNetworkingPushSubscription: vi.fn(), networkingParticipantExportContacts: vi.fn(),
  NETWORKING_DELIVERY_MAX_ATTEMPTS: 5,
}));
vi.mock("@app/db", () => db);
vi.mock("./delivery-policy", () => ({ networkingDeliverySkipReason: () => undefined }));
vi.mock("./notification-rendering", () => ({ renderNetworkingNotification: () => ({ title: "Title", body: "Body", subject: "Subject", attachments: [] }) }));
vi.mock("../email/providers", async (importOriginal) => ({
  ambiguousSend: (await importOriginal<typeof import("../email/providers")>()).ambiguousSend,
  getNetworkingEmailSender: () => undefined,
}));
import { networkingDeliveryWorkerOptions, processNetworkingDeliveries } from "./notification-worker";
import { NetworkingEmailRateLimiter } from "./email-rate-limiter";
const oldLease = new Date("2030-01-01T00:05:00Z");
const freshLease = new Date("2030-01-01T00:11:00Z");
const row = (lockedUntil: Date, overrides: Partial<NetworkingDeliveryRow> = {}) =>
  ({ id: "delivery", type: "OTP", eventId: "event", payload: {}, lockedUntil, attempts: 1, ...overrides }) as NetworkingDeliveryRow;
const email = { name: "resend" as const, isConfigured: () => true, sendEmail: vi.fn(), handleWebhook: vi.fn() };
const counts = (values: Partial<Record<"sent" | "skipped" | "failed" | "uncertain" | "deferred", number>>) =>
  ({ sent: 0, skipped: 0, failed: 0, uncertain: 0, deferred: 0, ...values });
let emailLimiter: NetworkingEmailRateLimiter;
const run = (extra: Parameters<typeof processNetworkingDeliveries>[0] = {}) =>
  processNetworkingDeliveries({ email, emailLimiter, options: { concurrency: 1, otpLanes: 1 }, ...extra });
/** The claim hands `rows` to the first lane that asks, then nothing. */
const claimOnce = (...rows: NetworkingDeliveryRow[]) =>
  db.claimNetworkingDeliveries.mockResolvedValueOnce(rows).mockResolvedValue([]);
beforeEach(() => {
  vi.resetAllMocks();
  emailLimiter = new NetworkingEmailRateLimiter(1_000);
  db.networkingDeliveryContext.mockResolvedValue({
    event: { clientId: "client", name: "Event" }, profile: { email: "test@example.test", firstName: "Test", emailPreference: "IMMEDIATE" },
    registration: { id: "registration" }, config: {}, subscriptions: [],
  });
  db.updateNetworkingDelivery.mockResolvedValue(true);
  db.refreshNetworkingDeliveryLease.mockResolvedValue(true);
  db.markNetworkingEmailAttempt.mockResolvedValue(true);
  db.beginNetworkingEmailLog.mockResolvedValue({ alreadySent: false });
  db.claimNetworkingDeliveries.mockResolvedValue([]);
  email.sendEmail.mockResolvedValue({ outcome: "accepted", success: true, messageId: "message" });
});
it("a stalled claimant cannot renew or dispatch; the fresh claimant sends once", async () => {
  claimOnce(row(oldLease), row(freshLease));
  db.refreshNetworkingDeliveryLease.mockImplementation(async (item) => item.lockedUntil === freshLease);
  expect(await run()).toEqual(counts({ sent: 1 }));
  expect(email.sendEmail).toHaveBeenCalledOnce();
  expect(db.beginNetworkingEmailLog).toHaveBeenCalledOnce();
  expect(db.updateNetworkingDelivery.mock.calls.every(([item]) => item.lockedUntil === freshLease)).toBe(true);
});
it("aborts without dispatch when ownership is lost during preparation", async () => {
  claimOnce(row(freshLease));
  db.refreshNetworkingDeliveryLease.mockResolvedValueOnce(true).mockResolvedValue(false);
  await run();
  expect(email.sendEmail).not.toHaveBeenCalled();
  expect(db.beginNetworkingEmailLog).not.toHaveBeenCalled();
});
it("refuses dispatch when tracking detects a live send or lost lease", async () => {
  claimOnce(row(freshLease));
  db.beginNetworkingEmailLog.mockResolvedValue({ alreadySent: false, leaseLost: true });
  expect(await run()).toEqual(counts({}));
  expect(email.sendEmail).not.toHaveBeenCalled();
});
it("writes the provider-attempt marker under the lease immediately before provider dispatch", async () => {
  claimOnce(row(freshLease));
  db.markNetworkingEmailAttempt.mockResolvedValue(false);
  await run();
  expect(db.beginNetworkingEmailLog).toHaveBeenCalledOnce();
  expect(db.markNetworkingEmailAttempt).toHaveBeenCalledWith(expect.anything(), "resend");
  expect(email.sendEmail).not.toHaveBeenCalled();
});
it("never marks a provider-accepted email failed when its sent bookkeeping fails", async () => {
  claimOnce(row(freshLease));
  db.finishNetworkingEmailLog.mockImplementation(async (_row, outcome) => {
    if (outcome === "sent") throw new Error("database unavailable");
  });
  expect(await run()).toEqual(counts({ sent: 1 }));
  expect(email.sendEmail).toHaveBeenCalledOnce();
  expect(db.finishNetworkingEmailLog).not.toHaveBeenCalledWith(expect.anything(), "failed");
  expect(db.updateNetworkingDelivery).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ payload: expect.objectContaining({ _deliveryProgress: { emailSent: true } }) }));
  expect(db.updateNetworkingDelivery).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: "FAILED" }));
});
it("abandons the claim without a failed retry when persisting sent progress throws", async () => {
  claimOnce(row(freshLease));
  db.updateNetworkingDelivery.mockRejectedValueOnce(new Error("database unavailable"));
  expect(await run()).toEqual(counts({}));
  expect(email.sendEmail).toHaveBeenCalledOnce();
  expect(db.finishNetworkingEmailLog).toHaveBeenCalledWith(expect.anything(), "sent", "message");
  expect(db.updateNetworkingDelivery).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: "FAILED" }));
});
it("still records a genuine provider rejection as a failed, retried email", async () => {
  claimOnce(row(freshLease));
  email.sendEmail.mockResolvedValue({ outcome: "rejected", success: false, statusCode: 400 });
  expect(await run()).toEqual(counts({ failed: 1 }));
  expect(db.finishNetworkingEmailLog).toHaveBeenCalledWith(expect.anything(), "failed");
  expect(db.updateNetworkingDelivery).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: "FAILED" }));
});

describe("ambiguous provider outcomes (3.6 classification)", () => {
  it.each([
    ["an ambiguous SendGrid answer", { outcome: "ambiguous", success: false, error: "socket hang up", idempotentRetry: false }],
    ["a provider that throws", new Error("connection reset")],
  ])("%s marks the email uncertain and is never retried", async (_label, answer) => {
    claimOnce(row(freshLease, { payload: { challengeId: "challenge", encryptedCode: "sealed" } }));
    if (answer instanceof Error) email.sendEmail.mockRejectedValue(answer);
    else email.sendEmail.mockResolvedValue(answer);
    expect(await run()).toEqual(counts({ uncertain: 1 }));
    expect(email.sendEmail).toHaveBeenCalledOnce();
    expect(db.finishNetworkingEmailLog).toHaveBeenCalledWith(expect.anything(), "uncertain", expect.stringContaining("not resent"));
    expect(db.finishNetworkingEmailLog).not.toHaveBeenCalledWith(expect.anything(), "failed");
    // Settled (no retry), and the sealed code is dropped.
    expect(db.updateNetworkingDelivery).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      status: "SENT",
      payload: { challengeId: "challenge", outcome: "email_uncertain" },
      lastError: expect.stringContaining("not resent"),
    }));
    expect(db.updateNetworkingDelivery).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: "FAILED" }));
  });
  it("retries an ambiguous Resend send under the same idempotency key while attempts remain", async () => {
    claimOnce(row(freshLease, { attempts: 2 }));
    email.sendEmail.mockResolvedValue({ outcome: "ambiguous", success: false, error: "timeout", idempotentRetry: true });
    expect(await run()).toEqual(counts({ failed: 1 }));
    expect(db.finishNetworkingEmailLog).toHaveBeenCalledWith(expect.anything(), "failed", expect.stringContaining("same idempotency key"));
    expect(db.updateNetworkingDelivery).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: "FAILED" }));
  });
  it("settles an ambiguous Resend send as uncertain on the last attempt", async () => {
    claimOnce(row(freshLease, { attempts: 5 }));
    email.sendEmail.mockResolvedValue({ outcome: "ambiguous", success: false, error: "timeout", idempotentRetry: true });
    expect(await run()).toEqual(counts({ uncertain: 1 }));
    expect(db.finishNetworkingEmailLog).toHaveBeenCalledWith(expect.anything(), "uncertain", expect.any(String));
  });
  it("does not call the provider again when an earlier attempt left the email uncertain", async () => {
    claimOnce(row(freshLease, { type: "MATCH" }));
    db.beginNetworkingEmailLog.mockResolvedValue({ alreadySent: false, uncertain: true });
    expect(await run()).toEqual(counts({ uncertain: 1 }));
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(db.markNetworkingEmailAttempt).not.toHaveBeenCalled();
    expect(db.updateNetworkingDelivery).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      payload: expect.objectContaining({ _deliveryProgress: { emailUncertain: true } }),
    }));
  });
  it("skips the email channel on a later claim once it is uncertain, and still delivers push", async () => {
    const push = vi.fn().mockResolvedValue({ statusCode: 201 });
    vi.stubEnv("NETWORKING_VAPID_PUBLIC_KEY", "test-public");
    vi.stubEnv("NETWORKING_VAPID_PRIVATE_KEY", "test-private");
    vi.stubEnv("NETWORKING_VAPID_SUBJECT", "mailto:test@example.invalid");
    try {
      claimOnce(row(freshLease, { type: "MATCH", payload: { _deliveryProgress: { emailUncertain: true } } }));
      db.networkingDeliveryContext.mockResolvedValue({
        event: { clientId: "client", name: "Event" }, profile: { email: "test@example.test", firstName: "Test", emailPreference: "IMMEDIATE" },
        registration: { id: "registration" }, config: {},
        subscriptions: [{ id: "sub", endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: { p256dh: "k", auth: "a" } }],
      });
      expect(await run({ push })).toEqual(counts({ uncertain: 1 }));
      expect(email.sendEmail).not.toHaveBeenCalled();
      expect(push).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("channels", () => {
  it("sends the email and then every push endpoint in one claim, revalidating once per channel", async () => {
    const push = vi.fn().mockResolvedValue({ statusCode: 201 });
    vi.stubEnv("NETWORKING_VAPID_PUBLIC_KEY", "test-public");
    vi.stubEnv("NETWORKING_VAPID_PRIVATE_KEY", "test-private");
    vi.stubEnv("NETWORKING_VAPID_SUBJECT", "mailto:test@example.invalid");
    try {
      claimOnce(row(freshLease, { type: "MATCH" }));
      const withSubscriptions = {
        event: { clientId: "client", name: "Event" }, profile: { email: "test@example.test", firstName: "Test", emailPreference: "IMMEDIATE" },
        registration: { id: "registration" }, config: {},
        subscriptions: [
          { id: "a", endpoint: "https://fcm.googleapis.com/fcm/send/a", keys: { p256dh: "k", auth: "a" } },
          { id: "b", endpoint: "https://web.push.apple.com/b", keys: { p256dh: "k", auth: "a" } },
        ],
      };
      db.networkingDeliveryContext.mockImplementation(async (_row, options?: { subscriptions?: boolean }) =>
        options?.subscriptions === false ? { ...withSubscriptions, subscriptions: [] } : withSubscriptions);
      expect(await run({ push })).toEqual(counts({ sent: 1 }));
      expect(email.sendEmail).toHaveBeenCalledOnce();
      expect(push).toHaveBeenCalledTimes(2);
      // Claim, email revalidation, push revalidation.
      expect(db.networkingDeliveryContext).toHaveBeenCalledTimes(3);
      expect(db.networkingDeliveryContext.mock.calls.map(([, options]) => options?.subscriptions)).toEqual([true, false, undefined]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("provider rate limit", () => {
  it("a 429 pauses the bucket and defers the delivery without counting an attempt", async () => {
    claimOnce(row(freshLease, { attempts: 3 }));
    email.sendEmail.mockResolvedValue({ outcome: "rejected", success: false, statusCode: 429 });
    const before = Date.now();
    expect(await run()).toEqual(counts({ deferred: 1 }));
    expect(db.finishNetworkingEmailLog).toHaveBeenCalledWith(expect.anything(), "deferred");
    const [, update] = db.updateNetworkingDelivery.mock.calls.at(-1)!;
    expect(update).toMatchObject({ status: "FAILED", attempts: 2, lockedUntil: null });
    expect(update.availableAt.getTime()).toBeGreaterThanOrEqual(before + 1_000);
  });
});

describe("stopping", () => {
  it("an email still waiting for a token is deferred without spending an attempt", async () => {
    claimOnce(row(freshLease, { attempts: 2 }));
    const controller = new AbortController();
    const limiter = new NetworkingEmailRateLimiter(1);
    await limiter.take("other"); // the bucket is empty: the next email waits a second
    const running = processNetworkingDeliveries({ email, emailLimiter: limiter, signal: controller.signal, options: { concurrency: 1, otpLanes: 1 } });
    await vi.waitFor(() => expect(limiter.pending).toBe(1));
    controller.abort(new Error("shutdown"));
    expect(await running).toEqual(counts({ deferred: 1 }));
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(db.markNetworkingEmailAttempt).not.toHaveBeenCalled();
    expect(db.finishNetworkingEmailLog).toHaveBeenCalledWith(expect.anything(), "deferred", expect.stringContaining("interrupted"));
    expect(db.updateNetworkingDelivery).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: "FAILED", attempts: 1 }));
  });
  it("hands back claimed rows a lane has not started once stopping", async () => {
    const controller = new AbortController();
    const first = row(freshLease, { id: "first", type: "MESSAGE", attempts: 1 });
    const second = row(freshLease, { id: "second", type: "MESSAGE", attempts: 3 });
    db.claimNetworkingDeliveries.mockImplementation(async (_limit: number, _eventId: string, lane: string) =>
      lane === "other" && !controller.signal.aborted ? [first, second] : []);
    email.sendEmail.mockImplementation(async () => {
      controller.abort();
      return { outcome: "accepted", success: true, messageId: "m" };
    });
    expect(await run({ signal: controller.signal })).toEqual(counts({ sent: 1 }));
    expect(email.sendEmail).toHaveBeenCalledOnce();
    expect(db.updateNetworkingDelivery).toHaveBeenCalledWith(second, { status: "PENDING", lockedUntil: null, attempts: 2 });
  });
});

describe("delivery lanes", () => {
  it("claims sign-in codes on dedicated lanes, one at a time, and everything else in batches", async () => {
    await processNetworkingDeliveries({ email, emailLimiter, eventId: "event", options: { concurrency: 2, otpLanes: 1, batchSize: 7 } });
    const calls = db.claimNetworkingDeliveries.mock.calls;
    expect(calls).toContainEqual([7, "event", "other"]);
    expect(calls).toContainEqual([1, "event", "otp"]);
  });
  it("sends a sign-in code that arrives while every general lane is busy with digests (not starved)", async () => {
    const digests = Array.from({ length: 200 }, (_, index) =>
      row(freshLease, { id: `digest-${index}`, type: "MESSAGE", payload: {} }));
    const otp = row(freshLease, { id: "otp", type: "OTP", payload: {} });
    const queue = [...digests];
    let otpQueued = false;
    db.claimNetworkingDeliveries.mockImplementation(async (limit: number, _eventId: string, lane: string) => {
      if (lane === "otp") {
        if (!otpQueued) return [];
        otpQueued = false;
        return [otp];
      }
      return queue.splice(0, limit);
    });
    let releaseDigests!: () => void;
    const digestsBlocked = new Promise<void>((resolve) => (releaseDigests = resolve));
    const sent: string[] = [];
    let busyLanes = 0;
    email.sendEmail.mockImplementation(async (input: { trackingId: string }) => {
      if (input.trackingId === "otp") {
        sent.push("otp");
        releaseDigests();
      } else {
        // Every general lane holds a digest in flight until the code went out.
        if (++busyLanes === 6) otpQueued = true;
        await digestsBlocked;
        sent.push(input.trackingId);
      }
      return { outcome: "accepted", success: true, messageId: input.trackingId };
    });
    const result = await processNetworkingDeliveries({
      email,
      emailLimiter,
      options: { concurrency: 6, otpLanes: 2, batchSize: 10 },
    });
    expect(result.sent).toBe(201);
    expect(sent.indexOf("otp")).toBe(0);
    expect(sent).toHaveLength(201);
  });
  it("stops claiming at the run deadline and finishes what it claimed", async () => {
    db.claimNetworkingDeliveries.mockImplementation(async (limit: number, _eventId: string, lane: string) =>
      lane === "otp" ? [] : Array.from({ length: limit }, (_, index) => row(freshLease, { id: `row-${index}`, type: "MESSAGE" })));
    const result = await processNetworkingDeliveries({
      email, emailLimiter, until: Date.now() - 1, options: { concurrency: 3, otpLanes: 1, batchSize: 5 },
    });
    expect(db.claimNetworkingDeliveries).not.toHaveBeenCalled();
    expect(result).toEqual(counts({}));
  });
});

describe("networkingDeliveryWorkerOptions", () => {
  it("defaults to 6 lanes of 10, 2 OTP lanes, 5 emails a second and a 1 s interval", () => {
    expect(networkingDeliveryWorkerOptions({})).toEqual({
      batchSize: 10, concurrency: 6, otpLanes: 2, emailRatePerSecond: 5, intervalMs: 1_000, runBudgetMs: 15_000,
    });
  });
  it("reads and validates the environment", () => {
    expect(networkingDeliveryWorkerOptions({
      NETWORKING_DELIVERY_BATCH_SIZE: "20", NETWORKING_DELIVERY_CONCURRENCY: "8",
      NETWORKING_DELIVERY_OTP_LANES: "3", NETWORKING_EMAIL_RATE_PER_SECOND: "12",
    })).toMatchObject({ batchSize: 20, concurrency: 8, otpLanes: 3, emailRatePerSecond: 12 });
    for (const [key, value] of [
      ["NETWORKING_DELIVERY_BATCH_SIZE", "0"],
      ["NETWORKING_DELIVERY_CONCURRENCY", "17"],
      ["NETWORKING_DELIVERY_OTP_LANES", "0"],
      ["NETWORKING_EMAIL_RATE_PER_SECOND", "1.5"],
    ])
      expect(() => networkingDeliveryWorkerOptions({ [key]: value })).toThrow(key);
  });
});
