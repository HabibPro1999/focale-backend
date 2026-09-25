import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createSendNowEmailLog,
  emailLogs,
  emailQueue,
  getDb,
  markEmailFailed,
  markEmailSent,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";

// 3.6b: a send-now email's row is born leased and marked as a provider
// attempt, so the lease-guarded settle writes apply to it and a crash
// mid-send is parked as UNCERTAIN, never requeued (both engines in CI).

const WORKER = "email-now:test";

async function readLog(id: string) {
  const [log] = await getDb().select().from(emailLogs).where(eq(emailLogs.id, id));
  return log!;
}

async function create(provider = "sendgrid") {
  return createSendNowEmailLog(
    { recipientEmail: "ada@example.test", recipientName: "Ada", subject: "Hello" },
    WORKER,
    provider,
  );
}

describe.runIf(dbTestsEnabled())("db tier: send-now email logs (3.6b)", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it("writes a leased, marked row with no retries", async () => {
    const log = await create();
    expect(log).toMatchObject({
      status: "SENDING",
      lockedBy: WORKER,
      provider: "sendgrid",
      maxRetries: 0,
      attemptCount: 1,
      recipientEmail: "ada@example.test",
      subject: "Hello",
    });
    expect(log.providerAttemptedAt).toBeInstanceOf(Date);
    expect(log.lastAttemptAt).toBeInstanceOf(Date);
    expect(log.lockedUntil!.getTime()).toBeGreaterThan(log.lockedAt!.getTime());
    // Never claimed by the queue worker.
    expect(await emailQueue.claim("worker-1", 10)).toEqual([]);
  });

  it("settles SENT, and FAILED without a requeue", async () => {
    const sent = await create();
    expect(await markEmailSent(sent.id, WORKER, "msg-1")).toBe(true);
    expect(await readLog(sent.id)).toMatchObject({
      status: "SENT",
      providerMessageId: "msg-1",
      lockedBy: null,
      lockedUntil: null,
    });

    const refused = await create();
    expect(await markEmailFailed(refused.id, WORKER, "550 rejected", 1, 0)).toBe(true);
    expect(await readLog(refused.id)).toMatchObject({
      status: "FAILED",
      errorMessage: "550 rejected",
      nextAttemptAt: null,
      lockedBy: null,
    });
  });

  it.each(["sendgrid", "resend"])("parks a %s row whose lease expired as UNCERTAIN", async (provider) => {
    const log = await create(provider);
    await getDb()
      .update(emailLogs)
      .set({ lockedUntil: new Date(Date.now() - 60_000) })
      .where(eq(emailLogs.id, log.id));

    expect(await emailQueue.recoverStale()).toEqual({ requeued: 0, deadLettered: 0, uncertain: 1 });
    expect(await readLog(log.id)).toMatchObject({ status: "UNCERTAIN", lockedBy: null });
    // The late outcome write loses: recovery owns the row now.
    expect(await markEmailSent(log.id, WORKER, "late")).toBe(false);
  });
});
