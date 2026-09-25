import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  emailLogs,
  getAlreadySentCertTemplateIds,
  getDb,
  runEmailSnapshotRetention,
  type EmailLogInsert,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedRegistration } from "../helpers/factories";

// 3.6b: the RetentionJob clears the context snapshot of finished emails queued
// more than 90 days ago, keeping a certificate email's template ids and
// leaving live, UNCERTAIN and networking rows alone (both engines in CI).

const DAY = 24 * 60 * 60 * 1000;
const SNAPSHOT = { firstName: "Ada", email: "ada@example.test", formData: { phone: "123" } };

async function seedLog(values: Partial<EmailLogInsert> & { ageDays: number }) {
  const { ageDays, ...rest } = values;
  const [log] = await getDb()
    .insert(emailLogs)
    .values({
      recipientEmail: "ada@example.test",
      subject: "Hello",
      status: "SENT",
      contextSnapshot: SNAPSHOT,
      queuedAt: new Date(Date.now() - ageDays * DAY),
      ...rest,
    })
    .returning({ id: emailLogs.id });
  return log!.id;
}

async function snapshotOf(id: string): Promise<unknown> {
  const [row] = await getDb()
    .select({ contextSnapshot: emailLogs.contextSnapshot })
    .from(emailLogs)
    .where(eq(emailLogs.id, id));
  return row!.contextSnapshot;
}

/**
 * Run passes until `done`. On CockroachDB, SKIP LOCKED can transiently skip
 * rows just written by a committed transaction (cockroachdb/cockroach#167582);
 * a later pass gets them, as the next hourly run would in production.
 */
async function retainUntil(done: () => Promise<boolean>, fullPass = true): Promise<number> {
  let cleared = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    cleared += (await runEmailSnapshotRetention({ fullPass, batchSize: 2 })).cleared;
    if (await done()) return cleared;
    await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
  }
  throw new Error("email snapshot retention did not converge");
}

describe.runIf(dbTestsEnabled())("db tier: email snapshot retention (3.6b)", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it("clears finished emails past 90 days, keeps certificate ids, leaves the rest", async () => {
    const registration = await seedRegistration();
    const certificateIds = ["cert-a", "cert-b"];
    const ids = {
      sent: await seedLog({ ageDays: 91 }),
      failed: await seedLog({ ageDays: 200, status: "FAILED" }),
      skipped: await seedLog({ ageDays: 95, status: "SKIPPED" }),
      opened: await seedLog({ ageDays: 120, status: "OPENED" }),
      certificate: await seedLog({
        ageDays: 100,
        status: "DELIVERED",
        trigger: "CERTIFICATE_SENT",
        registrationId: registration.id,
        contextSnapshot: { ...SNAPSHOT, _certificateTemplateIds: certificateIds },
      }),
      recent: await seedLog({ ageDays: 89 }),
      uncertain: await seedLog({ ageDays: 150, status: "UNCERTAIN" }),
      queued: await seedLog({ ageDays: 150, status: "QUEUED" }),
      networking: await seedLog({
        ageDays: 150,
        contextSnapshot: { dispatchOwner: "networking", eventId: "event-1" },
      }),
    };
    const cleared = ["sent", "failed", "skipped", "opened"] as const;

    const count = await retainUntil(async () => {
      for (const key of cleared) if ((await snapshotOf(ids[key])) !== null) return false;
      return Object.keys((await snapshotOf(ids.certificate)) as object).length === 1;
    });
    expect(count).toBe(5);

    expect(await snapshotOf(ids.certificate)).toEqual({ _certificateTemplateIds: certificateIds });
    for (const key of ["recent", "uncertain", "queued"] as const) {
      expect(await snapshotOf(ids[key])).toEqual(SNAPSHOT);
    }
    expect(await snapshotOf(ids.networking)).toEqual({ dispatchOwner: "networking", eventId: "event-1" });

    // The certificate send still sees what was sent.
    const sent = await getAlreadySentCertTemplateIds([registration.id]);
    expect([...(sent.get(registration.id) ?? [])].sort()).toEqual(certificateIds);

    // Everything is in its retained form: nothing left to rewrite.
    await expect(runEmailSnapshotRetention({ fullPass: true })).resolves.toEqual({ cleared: 0, complete: true });
  });

  it("after a full pass, only looks 7 days past the limit", async () => {
    const aged = await seedLog({ ageDays: 93 });
    const old = await seedLog({ ageDays: 120 });

    await retainUntil(async () => (await snapshotOf(aged)) === null, false);
    expect(await snapshotOf(old)).toEqual(SNAPSHOT);

    await retainUntil(async () => (await snapshotOf(old)) === null, true);
  });
});
