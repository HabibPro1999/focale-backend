import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { NetworkingConfigSchema } from "@app/contracts";
import {
  getDb,
  clients,
  forms,
  registrations,
  emailLogs,
  networkingStore,
  maintainNetworkingLifecycle,
  latestNetworkingPostEventReport,
  emailQueue,
  updateEmailLogById,
  type NetworkingRow,
} from "@app/db";
import {
  processNetworkingDeliveries as processDeliveryBatch,
  type NetworkingDeliveryDependencies,
} from "./notification-worker";
import { updateEmailStatusFromWebhook } from "../email/queue";
import type { EmailProvider, SendEmailInput } from "../email/providers";
import type { StorageProvider } from "../storage";
import { dbTestsEnabled } from "@app/db/testing";

const enabled = dbTestsEnabled();
const secret = "test-only-networking-worker-secret-more-than-32-characters";
const store = () => networkingStore();
function emailProvider(
  send = vi.fn(async (_input: SendEmailInput) => ({
    success: true,
    messageId: randomUUID(),
  })),
) {
  return {
    name: "resend",
    isConfigured: () => true,
    sendEmail: send,
    handleWebhook: () => ({ ok: false, reason: "unconfigured" }),
  } as unknown as EmailProvider;
}
function encryptedCode(code: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    createHash("sha256").update(secret).digest(),
    iv,
  );
  const body = Buffer.concat([cipher.update(code), cipher.final()]);
  return [iv, cipher.getAuthTag(), body]
    .map((value) => value.toString("base64url"))
    .join(".");
}
async function fixture(options: { ended?: boolean; timezone?: string } = {}) {
  const clientId = randomUUID(),
    eventId = randomUUID(),
    formId = randomUUID();
  const now = Date.now();
  await getDb()
    .insert(clients)
    .values({
      id: clientId,
      name: "Worker-only test client",
      enabledModules: ["networking", "registrations", "emails"],
    });
  const event = await store().insert("events", {
    id: eventId,
    clientId,
    name: "Événement اختبار",
    slug: `worker-${eventId}`,
    status: "OPEN",
    startDate: new Date(now - 48 * 3600000),
    endDate: new Date(now + (options.ended ? -25 : 48) * 3600000),
  });
  const config = NetworkingConfigSchema.parse({
    enabled: true,
    approvalMode: "AUTOMATIC",
    timezone: options.timezone ?? "UTC",
    defaultLanguage: "fr",
  });
  await store().insert("configs", { eventId, config });
  await getDb()
    .insert(forms)
    .values({
      id: formId,
      eventId,
      name: "Test registration",
      schema: { steps: [] },
    });
  const people: NetworkingRow<"profiles">[] = [];
  for (const [index, language] of ["fr", "ar"].entries()) {
    const id = randomUUID();
    await getDb()
      .insert(registrations)
      .values({
        id,
        eventId,
        formId,
        email: `${eventId}-${index}@example.invalid`,
        firstName: index ? "كريم" : "Amel",
        paymentStatus: "PAID",
        networkingOptIn: true,
        totalAmount: 0,
        priceBreakdown: {},
        formData: {},
      });
    people.push(
      await store().insert("profiles", {
        eventId,
        registrationId: id,
        email: `${eventId}-${index}@example.invalid`,
        firstName: index ? "كريم" : "Amel",
        lastName: "Fixture",
        company: "Test only",
        sector: index ? "Health" : "Software",
        status: "ACTIVE",
        consent: true,
        language: language as "fr" | "ar",
      }),
    );
  }
  const connection = await store().insert("connections", {
    eventId,
    profileAId: people[0].id,
    profileBId: people[1].id,
  });
  const message = await store().insert("messages", {
    eventId,
    connectionId: connection.id,
    senderId: people[1].id,
    body: "Bonjour <script>bad()</script> مرحباً",
    clientMessageId: randomUUID(),
  });
  const table = await store().insert("tables", {
    eventId,
    name: "Table <A>",
    location: "Hall événement",
  });
  return { eventId, event, config, people, connection, message, table };
}
// Like the scheduled worker, poll past transient SKIP LOCKED misses on committed
// CockroachDB intents (cockroachdb/cockroach#167582); retain all dispatch assertions.
async function processNetworkingDeliveries(
  deps: NetworkingDeliveryDependencies & { eventId: string },
) {
  const result = { sent: 0, skipped: 0, failed: 0 };
  await vi.waitFor(async () => {
    const batch = await processDeliveryBatch(deps);
    result.sent += batch.sent;
    result.skipped += batch.skipped;
    result.failed += batch.failed;
    const rows = await store().all("deliveries", { eventId: deps.eventId });
    const now = new Date();
    const due = rows.filter(row =>
      row.attempts < 5 && row.availableAt <= now &&
      (row.status === "PENDING" || row.status === "FAILED" ||
       (row.status === "PROCESSING" && row.lockedUntil && row.lockedUntil <= now)),
    );
    expect(due).toHaveLength(0);
  }, { timeout: 3000, interval: 20 });
  return result;
}
async function delivery(
  f: Awaited<ReturnType<typeof fixture>>,
  type = "MESSAGE",
  payload: Record<string, unknown> = {},
  profileIndex = 0,
) {
  return store().insert("deliveries", {
    eventId: f.eventId,
    profileId: f.people[profileIndex].id,
    type,
    payload: {
      connectionId: f.connection.id,
      ...(type === "MESSAGE" ? { messageId: f.message.id } : {}),
      ...payload,
    },
    dedupeKey: randomUUID(),
    availableAt: new Date(Date.now() - 1000),
  });
}
async function forceDue(id: string) {
  await store().update(
    "deliveries",
    { id },
    { availableAt: new Date(Date.now() - 1000) },
  );
}
async function meeting(
  f: Awaited<ReturnType<typeof fixture>>,
  hours: number,
  createdHoursBefore: number,
) {
  const start = new Date(Date.now() + hours * 3600000);
  return store().insert("meetings", {
    eventId: f.eventId,
    requesterId: f.people[0].id,
    recipientId: f.people[1].id,
    tableId: f.table.id,
    startsAt: start,
    endsAt: new Date(start.getTime() + 1800000),
    expiresAt: new Date(start.getTime() - 1000),
    status: "CONFIRMED",
    revision: 1,
    createdAt: new Date(start.getTime() - createdHoursBefore * 3600000),
  });
}
async function log(id: string) {
  return (await getDb().select().from(emailLogs)).find((row) => row.id === id)!;
}

describe.runIf(enabled)("networking worker real isolated database", () => {
  beforeAll(() => {
    process.env.NETWORKING_TOKEN_SECRET = secret;
    process.env.PUBLIC_NETWORKING_URL = "https://networking.example.invalid";
    process.env.NETWORKING_VAPID_PUBLIC_KEY = "test-only-public";
    process.env.NETWORKING_VAPID_PRIVATE_KEY = "test-only-private";
    process.env.NETWORKING_VAPID_SUBJECT = "mailto:test@example.invalid";
  });
  it("atomically creates revision-deduplicated day/hour reminders and matching localized in-app records under concurrent maintenance", async () => {
    const f = await fixture();
    await meeting(f, 23.5, 30);
    await meeting(f, 0.5, 2);
    await Promise.all([
      maintainNetworkingLifecycle(f.eventId),
      maintainNetworkingLifecycle(f.eventId),
    ]);
    const deliveries = await store().all("deliveries", { eventId: f.eventId });
    const notifications = await store().all("notifications", {
      eventId: f.eventId,
    });
    expect(deliveries).toHaveLength(4);
    expect(notifications).toHaveLength(4);
    expect(notifications.map((row) => row.href)).toEqual(
      Array(4).fill(`/e/worker-${f.eventId}/agenda`),
    );
    for (const row of deliveries)
      expect(
        notifications.some(
          (item) =>
            item.id === row.payload.notificationId &&
            item.profileId === row.profileId &&
            item.type === row.type,
        ),
      ).toBe(true);
    expect(notifications.some((row) => row.title === "موعدك غداً")).toBe(true);
    expect(
      notifications.some(
        (row) => row.title === "Votre rendez-vous commence dans une heure",
      ),
    ).toBe(true);
  });
  it("does not deliver old meeting revisions or expired proposals", async () => {
    const f = await fixture();
    const m = await meeting(f, 4, 6);
    const row = await delivery(f, "MEETING_ACCEPT", {
      meetingId: m.id,
      revision: 1,
    });
    await store().update("meetings", { id: m.id }, { revision: 2 });
    const send = vi.fn();
    expect(
      await processNetworkingDeliveries({
        eventId: f.eventId,
        email: emailProvider(send),
      }),
    ).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(
      (await store().one("deliveries", { id: row.id }))?.payload.outcome,
    ).toBe("meeting_changed");
  });
  it("bumps revisions when expiring pending meetings and reschedule proposals", async () => {
    const f = await fixture();
    const a = await meeting(f, 4, 6);
    const b = await meeting(f, 6, 8);
    await store().update(
      "meetings",
      { id: a.id },
      { status: "PENDING", expiresAt: new Date(Date.now() - 1000) },
    );
    await store().update(
      "meetings",
      { id: b.id },
      {
        proposedStartsAt: new Date(Date.now() + 7 * 3600000),
        proposalBy: f.people[0].id,
        expiresAt: new Date(Date.now() - 1000),
      },
    );
    await maintainNetworkingLifecycle(f.eventId);
    expect(await store().one("meetings", { id: a.id })).toMatchObject({
      status: "EXPIRED",
      revision: 2,
    });
    expect(await store().one("meetings", { id: b.id })).toMatchObject({
      status: "CONFIRMED",
      proposedStartsAt: null,
      revision: 2,
    });
  });
  it("revalidates symmetric blocks, counterpart payment and participant consent before dispatch", async () => {
    const f = await fixture();
    const send = vi.fn();
    const block = await store().insert("blocks", {
      eventId: f.eventId,
      profileId: f.people[1].id,
      targetId: f.people[0].id,
    });
    const blocked = await delivery(f);
    await processNetworkingDeliveries({
      eventId: f.eventId,
      email: emailProvider(send),
    });
    expect(
      (await store().one("deliveries", { id: blocked.id }))?.payload.outcome,
    ).toBe("participants_blocked");
    await store().remove("blocks", { id: block.id });
    await store().update(
      "registrations",
      { id: f.people[1].registrationId },
      { paymentStatus: "REFUNDED" },
    );
    const refunded = await delivery(f);
    await processNetworkingDeliveries({
      eventId: f.eventId,
      email: emailProvider(send),
    });
    expect(
      (await store().one("deliveries", { id: refunded.id }))?.payload.outcome,
    ).toBe("contact_ineligible");
    await store().update(
      "profiles",
      { id: f.people[0].id },
      { consent: false },
    );
    const withdrawn = await delivery(f);
    await processNetworkingDeliveries({
      eventId: f.eventId,
      email: emailProvider(send),
    });
    expect(
      (await store().one("deliveries", { id: withdrawn.id }))?.payload.outcome,
    ).toBe("participant_ineligible");
    expect(send).not.toHaveBeenCalled();
  });
  it("retries email and each push endpoint independently without replaying successful channels", async () => {
    const f = await fixture();
    const row = await delivery(f);
    const endpointA = "https://fcm.googleapis.com/fcm/send/test-a",
      endpointB = "https://web.push.apple.com/test-b";
    for (const endpoint of [endpointA, endpointB])
      await store().insert("pushSubscriptions", {
        eventId: f.eventId,
        profileId: f.people[0].id,
        endpoint: `${endpoint}-${f.eventId}`,
        keys: { p256dh: "test-key", auth: "test-auth" },
      });
    let emailAttempt = 0,
      attemptsB = 0;
    const send = vi.fn(async (_input: SendEmailInput) => ({
      success: ++emailAttempt > 1,
      messageId: "provider-test-id",
    }));
    const push = vi.fn(async (subscription: { endpoint: string }) => {
      if (subscription.endpoint.includes("test-b") && ++attemptsB < 3)
        throw new Error("test push failure");
      return { statusCode: 201, headers: {}, body: "" };
    });
    const deps = { eventId: f.eventId, email: emailProvider(send), push };
    expect((await processNetworkingDeliveries(deps)).failed).toBe(1);
    await forceDue(row.id);
    expect((await processNetworkingDeliveries(deps)).failed).toBe(1);
    await forceDue(row.id);
    expect((await processNetworkingDeliveries(deps)).sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      push.mock.calls.filter(([subscription]) =>
        subscription.endpoint.includes("test-a"),
      ),
    ).toHaveLength(1);
    expect(attemptsB).toBe(3);
    expect(await log(row.id)).toMatchObject({
      status: "SENT",
      providerMessageId: "provider-test-id",
      contextSnapshot: {
        dispatchOwner: "networking",
        eventId: f.eventId,
        deliveryId: row.id,
      },
    });
    const pushed = JSON.parse(String((push.mock.calls as unknown[][])[0][1]));
    expect(pushed.href).toContain(`/e/${f.event.slug}/connections/`);
  });
  it("keeps provider webhook open/click state when it arrives before the send result", async () => {
    const f = await fixture();
    const row = await delivery(f);
    const send = vi.fn(async (input: SendEmailInput) => {
      await updateEmailStatusFromWebhook(input.trackingId!, "open");
      await updateEmailStatusFromWebhook(input.trackingId!, "click");
      return { success: true, messageId: "tracked-test" };
    });
    await processNetworkingDeliveries({
      eventId: f.eventId,
      email: emailProvider(send),
    });
    expect(await log(row.id)).toMatchObject({
      status: "CLICKED",
      providerMessageId: "tracked-test",
    });
    expect((await log(row.id)).openedAt).not.toBeNull();
  });
  it("localizes message bodies and meeting statuses in French and Arabic while escaping snippets", async () => {
    const f = await fixture();
    const messageDelivery = await delivery(f);
    const m = await meeting(f, 4, 6);
    await delivery(
      f,
      "MEETING_ACCEPT",
      { meetingId: m.id, revision: m.revision },
      1,
    );
    const send = vi.fn(async (_input: SendEmailInput) => ({
      success: true,
      messageId: randomUUID(),
    }));
    await processNetworkingDeliveries({
      eventId: f.eventId,
      email: emailProvider(send),
      batchSize: 10,
    });
    const french = send.mock.calls.find(
      ([input]) => input.trackingId === messageDelivery.id,
    )![0];
    expect(french.plainText).toContain("Un message de");
    expect(french.html).toContain("&lt;script&gt;");
    expect(french.html).not.toContain("<script>");
    const arabic = send.mock.calls.find(
      ([input]) => input.to === f.people[1].email,
    )![0];
    expect(arabic.html).toContain('dir="rtl"');
    expect(arabic.plainText).toContain("الحالة: مؤكد".replace("مؤكد", "مؤكّد"));
    expect(arabic.plainText).not.toContain("CONFIRMED");
    expect(
      Buffer.from(arabic.attachments![0].content, "base64").toString(),
    ).toContain(`SEQUENCE:${m.revision}`);
  });
  it("distinguishes a rejected new time from a declined meeting in email and in-app notices", async () => {
    const f = await fixture();
    const confirmed = await meeting(f, 4, 6);
    const declined = await meeting(f, 5, 6);
    await store().update("meetings", { id: declined.id }, { status: "DECLINED" });
    const send = vi.fn(async (_input: SendEmailInput) => ({ success: true }));
    const notices: { notification: NetworkingRow<"notifications">; row: NetworkingRow<"deliveries"> }[] = [];
    for (const m of [confirmed, declined]) {
      const notification = await store().insert("notifications", {
        eventId: f.eventId, profileId: f.people[0].id,
        type: "MEETING_DECLINE", title: "Meeting update", body: "",
      });
      const row = await delivery(f, "MEETING_DECLINE", {
        meetingId: m.id, revision: m.revision, notificationId: notification.id,
      });
      notices.push({ notification, row });
    }
    expect((await processNetworkingDeliveries({ eventId: f.eventId, email: emailProvider(send) })).sent).toBe(2);
    const reschedule = send.mock.calls.find(([input]) => input.trackingId === notices[0].row.id)![0];
    const rejection = send.mock.calls.find(([input]) => input.trackingId === notices[1].row.id)![0];
    expect(reschedule.subject).toContain("Le nouveau créneau a été refusé");
    expect(reschedule.plainText).toContain("le rendez-vous initial est maintenu");
    expect(reschedule.plainText).toContain("Statut: Confirmé");
    expect(rejection.subject).toContain("La demande de rendez-vous a été refusée");
    expect(rejection.plainText).toContain("Statut: Refusé");
    expect((await store().one("notifications", { id: notices[0].notification.id }))?.title)
      .toContain("le rendez-vous initial est maintenu");
  });
  it("sends valid OTPs without retaining encrypted or plaintext secrets in delivery payloads or email logs", async () => {
    const f = await fixture();
    await store().update(
      "profiles",
      { id: f.people[0].id },
      { emailPreference: "OFF" },
    );
    const challenge = await store().insert("challenges", {
      eventId: f.eventId,
      email: f.people[0].email,
      codeHash: "test-only-hash",
      expiresAt: new Date(Date.now() + 600000),
    });
    const row = await delivery(f, "OTP", {
      challengeId: challenge.id,
      encryptedCode: encryptedCode("654321"),
    });
    const send = vi.fn(async (_input: SendEmailInput) => ({
      success: true,
      messageId: "otp-test",
    }));
    expect(
      (
        await processNetworkingDeliveries({
          eventId: f.eventId,
          email: emailProvider(send),
        })
      ).sent,
    ).toBe(1);
    expect(send.mock.calls[0][0].plainText).toContain("654321");
    const saved = await store().one("deliveries", { id: row.id });
    expect(saved?.payload).toEqual({
      challengeId: challenge.id,
      outcome: "sent",
    });
    expect(JSON.stringify(await log(row.id))).not.toContain("654321");
    expect(JSON.stringify(await log(row.id))).not.toContain("encryptedCode");
  });
  it("scrubs expired and retry-exhausted OTPs without any provider call", async () => {
    const f = await fixture();
    const challenge = await store().insert("challenges", {
      eventId: f.eventId,
      email: f.people[0].email,
      codeHash: "test-only-hash",
      expiresAt: new Date(Date.now() - 1000),
    });
    const row = await delivery(f, "OTP", {
      challengeId: challenge.id,
      encryptedCode: encryptedCode("654321"),
    });
    const send = vi.fn();
    await maintainNetworkingLifecycle(f.eventId);
    await processNetworkingDeliveries({
      eventId: f.eventId,
      email: emailProvider(send),
    });
    expect(await store().one("deliveries", { id: row.id })).toMatchObject({
      status: "SKIPPED",
      payload: { outcome: "expired" },
    });
    expect(
      JSON.stringify(
        (await store().one("deliveries", { id: row.id }))?.payload,
      ),
    ).not.toContain("encryptedCode");
    expect(send).not.toHaveBeenCalled();
    const active = await store().insert("challenges", {
      eventId: f.eventId,
      email: f.people[0].email,
      codeHash: "test-only-hash",
      expiresAt: new Date(Date.now() + 600000),
    });
    const exhausted = await delivery(f, "OTP", {
      challengeId: active.id,
      encryptedCode: encryptedCode("654321"),
    });
    await store().update(
      "deliveries",
      { id: exhausted.id },
      { attempts: 5, status: "FAILED" },
    );
    await maintainNetworkingLifecycle(f.eventId);
    expect(
      (await store().one("deliveries", { id: exhausted.id }))?.payload,
    ).not.toHaveProperty("encryptedCode");
  });
  it("creates one previous-day digest and honors read state and updated preferences at dispatch", async () => {
    const zones = [
      "UTC",
      "Asia/Tokyo",
      "America/Los_Angeles",
      "Pacific/Honolulu",
    ];
    const timezone = zones.find(
      (zone) =>
        Number(
          new Intl.DateTimeFormat("en", {
            timeZone: zone,
            hour: "2-digit",
            hourCycle: "h23",
          }).format(new Date()),
        ) >= 8,
    )!;
    const f = await fixture({ timezone });
    await store().update(
      "profiles",
      { id: f.people[0].id },
      { emailPreference: "DAILY" },
    );
    const notification = await store().insert("notifications", {
      eventId: f.eventId,
      profileId: f.people[0].id,
      type: "MATCH",
      title: "Old unlocalized title",
      body: "Old body",
      data: { connectionId: f.connection.id },
      createdAt: new Date(Date.now() - 24 * 3600000),
    });
    await maintainNetworkingLifecycle(f.eventId);
    await maintainNetworkingLifecycle(f.eventId);
    const digests = await store().all("deliveries", {
      eventId: f.eventId,
      type: "DAILY_DIGEST",
    });
    expect(digests).toHaveLength(1);
    const send = vi.fn(async (_input: SendEmailInput) => ({
      success: true,
      messageId: "digest",
    }));
    await processNetworkingDeliveries({
      eventId: f.eventId,
      email: emailProvider(send),
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].plainText).toContain("Notifications non lues");
    expect(send.mock.calls[0][0].plainText).not.toContain("Old body");
    await delivery(f, "DAILY_DIGEST", { notificationIds: [notification.id] });
    await store().update(
      "profiles",
      { id: f.people[0].id },
      { emailPreference: "OFF" },
    );
    await processNetworkingDeliveries({
      eventId: f.eventId,
      email: emailProvider(send),
    });
    expect(send).toHaveBeenCalledOnce();
  });
  it("the generic email worker never claims or recovers networking-owned rows but still processes ordinary logs", async () => {
    const ids = Array.from({ length: 5 }, () => randomUUID());
    const past = new Date(Date.now() - 3600000);
    await getDb()
      .insert(emailLogs)
      .values(
        ids.map((id, index) => ({
          id,
          recipientEmail: "test@example.invalid",
          subject: "Queue ownership test",
          status: index < 2 ? ("QUEUED" as const) : ("SENDING" as const),
          contextSnapshot: [0, 2, 4].includes(index)
            ? { dispatchOwner: "networking" }
            : null,
          lockedUntil: index >= 2 ? past : null,
          lockedAt: index >= 2 ? past : null,
          retryCount: index === 4 ? 9 : 0,
          updatedAt: past,
        })),
      );
    const claimed: string[] = [];
    await vi.waitFor(async () => {
      claimed.push(...await emailQueue.claim("ordinary-test-worker", 100, 60000));
      expect(claimed).toContain(ids[1]);
    }, { timeout: 3000, interval: 20 });
    expect(claimed).not.toContain(ids[0]);
    await emailQueue.recoverStale();
    expect((await log(ids[2])).status).toBe("SENDING");
    expect((await log(ids[4])).status).toBe("SENDING");
    expect((await log(ids[3])).status).toBe("QUEUED");
    for (const id of ids) await updateEmailLogById(id, { status: "SKIPPED" });
  });
  it("claims each delivery once under competing networking workers", async () => {
    const f = await fixture();
    await delivery(f);
    const send = vi.fn(async (_input: SendEmailInput) => ({
      success: true,
      messageId: randomUUID(),
    }));
    await Promise.all([
      processNetworkingDeliveries({
        eventId: f.eventId,
        email: emailProvider(send),
      }),
      processNetworkingDeliveries({
        eventId: f.eventId,
        email: emailProvider(send),
      }),
    ]);
    expect(send).toHaveBeenCalledOnce();
  });
  it("does not create reminders for a blocked counterpart and purges expired profiles even after the module was disabled", async () => {
    const blocked = await fixture();
    await meeting(blocked, 23.5, 30);
    await store().insert("blocks", {
      eventId: blocked.eventId,
      profileId: blocked.people[1].id,
      targetId: blocked.people[0].id,
    });
    await maintainNetworkingLifecycle(blocked.eventId);
    expect(
      await store().all("notifications", { eventId: blocked.eventId }),
    ).toHaveLength(0);
    const expired = await fixture({ ended: true });
    await store().update(
      "configs",
      { eventId: expired.eventId },
      { config: { ...expired.config, enabled: false, retentionDays: 1 } },
    );
    await maintainNetworkingLifecycle(expired.eventId);
    expect(
      await store().all("profiles", { eventId: expired.eventId }),
    ).toHaveLength(0);
    expect(
      await store().all("registrations", { eventId: expired.eventId }),
    ).toHaveLength(2);
  });
  it("honors OFF email preference, and revalidates blocks between email and push dispatch", async () => {
    const f = await fixture();
    await store().insert("pushSubscriptions", {
      eventId: f.eventId,
      profileId: f.people[0].id,
      endpoint: `https://fcm.googleapis.com/test-${f.eventId}`,
      keys: { p256dh: "test", auth: "test" },
    });
    const push = vi.fn(async () => ({
      statusCode: 201,
      headers: {},
      body: "",
    }));
    const send = vi.fn(async (_input: SendEmailInput) => {
      await store().insert("blocks", {
        eventId: f.eventId,
        profileId: f.people[1].id,
        targetId: f.people[0].id,
      });
      return { success: true, messageId: "accepted-before-block" };
    });
    await delivery(f);
    await processNetworkingDeliveries({
      eventId: f.eventId,
      email: emailProvider(send),
      push,
    });
    expect(send).toHaveBeenCalledOnce();
    expect(push).not.toHaveBeenCalled();
    const off = await fixture();
    await store().update(
      "profiles",
      { id: off.people[0].id },
      { emailPreference: "OFF" },
    );
    await delivery(off);
    await processNetworkingDeliveries({
      eventId: off.eventId,
      email: emailProvider(send),
      push,
    });
    expect(send).toHaveBeenCalledOnce();
  });
  it("includes organizer warning notes and actionable authenticated meeting links with both calendar alarms", async () => {
    const f = await fixture();
    const warning = await delivery(f, "MODERATION_WARNING", {
      note: "Veuillez respecter les échanges professionnels <script>unsafe()</script>",
    });
    const m = await meeting(f, 4, 6);
    await store().update("meetings", { id: m.id }, { status: "PENDING" });
    const request = await delivery(
      f,
      "MEETING_REQUEST",
      { meetingId: m.id, revision: m.revision },
      1,
    );
    const send = vi.fn(async (_input: SendEmailInput) => ({
      success: true,
      messageId: randomUUID(),
    }));
    await processNetworkingDeliveries({
      eventId: f.eventId,
      email: emailProvider(send),
      batchSize: 10,
    });
    const note = send.mock.calls.find(
      ([input]) => input.trackingId === warning.id,
    )![0];
    expect(note.plainText).toContain("Veuillez respecter");
    expect(note.html).not.toContain("<script>");
    const requestEmail = send.mock.calls.find(
      ([input]) => input.trackingId === request.id,
    )![0];
    expect(requestEmail.html).toContain(
      `meetingId=${m.id}&amp;response=ACCEPT`,
    );
    expect(requestEmail.html).toContain("response=RESCHEDULE");
    await store().update(
      "meetings",
      { id: m.id },
      { status: "CONFIRMED", revision: 2 },
    );
    await store().update("configs", { eventId: f.eventId }, { config: { ...f.config, emailTemplates: { MEETING_ACCEPT: { subject: "Custom confirmation", body: "Your appointment is confirmed." } } } });
    const assigned = await delivery(f, "MEETING_ASSIGN", {
      meetingId: m.id,
      revision: 2,
    });
    await processNetworkingDeliveries({
      eventId: f.eventId,
      email: emailProvider(send),
    });
    const confirmation = send.mock.calls.find(
      ([input]) => input.trackingId === assigned.id,
    )![0];
    expect(confirmation.subject).toBe("Custom confirmation");
    expect(confirmation.plainText).toContain("Your appointment is confirmed.");
    const ics = Buffer.from(
      confirmation.attachments![0].content,
      "base64",
    ).toString();
    expect(ics).toContain("TRIGGER:-P1D");
    expect(ics).toContain("TRIGGER:-PT1H");
  });
  it("automatically sends one accurate, formula-safe connection CSV without private registration addresses", async () => {
    const f = await fixture({ ended: true });
    await store().update("profiles", { id: f.people[1].id }, { company: '=HYPERLINK("https://example.invalid")', emailPreference: "OFF" });
    const storage = { uploadPrivate: vi.fn(async (_buffer: Buffer, key: string) => key) } as unknown as StorageProvider;
    const send = vi.fn(async (_input: SendEmailInput) => ({ success: true, messageId: randomUUID() }));
    await maintainNetworkingLifecycle(f.eventId); await maintainNetworkingLifecycle(f.eventId);
    expect(await store().all("deliveries", { eventId: f.eventId, type: "POST_EVENT_CONTACTS" })).toHaveLength(2);
    await processNetworkingDeliveries({ eventId: f.eventId, email: emailProvider(send), storage, batchSize: 10 });
    expect(send).toHaveBeenCalledOnce(); const input = send.mock.calls[0][0];
    expect(input.plainText).toContain("Connexions éligibles incluses: 1");
    const attachment = input.attachments!.find(item => item.filename.endsWith(".csv"))!; const csv = Buffer.from(attachment.content, "base64").toString();
    expect(csv).toContain("Prénom"); expect(csv).toContain("'=HYPERLINK"); expect(csv).not.toContain(f.people[1].email); expect(csv.split("\r\n").filter(Boolean)).toHaveLength(2);
    await maintainNetworkingLifecycle(f.eventId); await processNetworkingDeliveries({ eventId: f.eventId, email: emailProvider(send), storage, batchSize: 10 }); expect(send).toHaveBeenCalledOnce();
  });
  it("includes post-event contacts in the next DAILY digest even if its in-app notice was already read", async () => {
    const zones = ["UTC", "Asia/Tokyo", "America/Los_Angeles", "Pacific/Honolulu"];
    const timezone = zones.find(zone => Number(new Intl.DateTimeFormat("en", { timeZone: zone, hour: "2-digit", hourCycle: "h23" }).format(new Date())) >= 8)!;
    const f = await fixture({ ended: true, timezone }); await store().update("profiles", { id: f.people[0].id }, { emailPreference: "DAILY" }); await store().update("profiles", { id: f.people[1].id }, { emailPreference: "OFF" });
    const storage = { uploadPrivate: vi.fn(async (_buffer: Buffer, key: string) => key) } as unknown as StorageProvider;
    const send = vi.fn(async (_input: SendEmailInput) => ({ success: true, messageId: randomUUID() }));
    await maintainNetworkingLifecycle(f.eventId); await processNetworkingDeliveries({ eventId: f.eventId, email: emailProvider(send), storage, batchSize: 10 }); expect(send).not.toHaveBeenCalled();
    const notification = await store().one("notifications", { eventId: f.eventId, profileId: f.people[0].id, type: "POST_EVENT_CONTACTS" });
    await store().update("notifications", { id: notification!.id }, { createdAt: new Date(Date.now() - 24 * 3600000), readAt: new Date() });
    await maintainNetworkingLifecycle(f.eventId); await processNetworkingDeliveries({ eventId: f.eventId, email: emailProvider(send), storage, batchSize: 10 });
    expect(send).toHaveBeenCalledOnce(); expect(send.mock.calls[0][0].attachments?.some(item => item.filename === "networking-connections.csv")).toBe(true);
  });
  it("generates one private aggregate post-event PDF and exposes a durable storage record", async () => {
    const f = await fixture({ ended: true });
    for (const person of f.people) await store().update("profiles", { id: person.id }, { emailPreference: "OFF" });
    const upload = vi.fn(async (_buffer: Buffer, key: string) => key);
    const storage = { uploadPrivate: upload } as unknown as StorageProvider;
    const send = vi.fn();
    await maintainNetworkingLifecycle(f.eventId);
    expect(
      (
        await processNetworkingDeliveries({
          eventId: f.eventId,
          email: emailProvider(send),
          storage,
        })
      ).sent,
    ).toBe(3);
    const report = await latestNetworkingPostEventReport(f.eventId);
    expect(report?.storageKey).toMatch(
      new RegExp(`^networking/reports/${f.eventId}/`),
    );
    expect(report?.summary.participants).toBe(2);
    expect(upload.mock.calls[0][0].subarray(0, 4).toString()).toBe("%PDF");
    await maintainNetworkingLifecycle(f.eventId);
    await processNetworkingDeliveries({
      eventId: f.eventId,
      email: emailProvider(send),
      storage,
    });
    expect(upload).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });
});
