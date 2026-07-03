import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  findUsageAmountsByRegistration,
  getDb,
  insertUsage,
  registrations,
  updateRegistrationSettlement,
  withTxn,
  type DbExecutor,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import { makeBarrier } from "../helpers/barrier";
import {
  seedEvent,
  seedForm,
  seedRegistration,
  seedSponsorship,
  seedSponsorshipBatch,
} from "../helpers/factories";

// Settlement drift. Linking a sponsorship recomputes registrations.sponsorship_amount
// as the SUM of its usage rows (recompute-from-children). ADR-0001 says such paths
// MUST take a pessimistic lock (SELECT ... FOR UPDATE) on the parent registration
// before the read-modify-write, else two concurrent links each read only their own
// uncommitted usage under READ COMMITTED and the last writer clobbers the other.
//
// The settle body below is the service's link transaction re-expressed against the
// @app/db query fns (insertUsage → findUsageAmountsByRegistration → sum →
// updateRegistrationSettlement). `lock` toggles the ADR-0001 remedy.
async function settleLink(
  registrationId: string,
  sponsorshipId: string,
  amount: number,
  opts: { lock: boolean; barrier?: () => Promise<void> },
): Promise<void> {
  await withTxn(async (tx: DbExecutor) => {
    if (opts.lock) {
      await tx.execute(
        sql`SELECT id FROM registrations WHERE id = ${registrationId} FOR UPDATE`,
      );
    }
    await insertUsage(tx, {
      sponsorshipId,
      registrationId,
      amountApplied: amount,
      appliedBy: "concurrency-test",
    });
    const usages = await findUsageAmountsByRegistration(tx, registrationId);
    const total = usages.reduce((sum, u) => sum + u.amountApplied, 0);
    if (opts.barrier) await opts.barrier();
    await updateRegistrationSettlement(tx, registrationId, {
      sponsorshipAmount: total,
    });
  });
}

async function seedRegAndSponsors(amounts: number[]) {
  const event = await seedEvent({ status: "OPEN" });
  const form = await seedForm({ eventId: event.id });
  const registration = await seedRegistration({
    eventId: event.id,
    formId: form.id,
    totalAmount: 1000,
  });
  const batch = await seedSponsorshipBatch({ eventId: event.id, formId: form.id });
  const sponsorships = await Promise.all(
    amounts.map((amt) =>
      seedSponsorship({
        batchId: batch.id,
        eventId: event.id,
        totalAmount: amt,
      }),
    ),
  );
  return { registration, sponsorships };
}

async function readSettlement(registrationId: string): Promise<number> {
  const [row] = await getDb()
    .select({ sponsorshipAmount: registrations.sponsorshipAmount })
    .from(registrations)
    .where(eq(registrations.id, registrationId));
  return row.sponsorshipAmount;
}

describe.runIf(dbTestsEnabled())("concurrency: settlement drift", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it("FOR UPDATE lock serializes settlement recompute (ADR-0001 remedy — no drift)", async () => {
    const amounts = [300, 200];
    const { registration, sponsorships } = await seedRegAndSponsors(amounts);

    await Promise.all(
      sponsorships.map((s, i) =>
        settleLink(registration.id, s.id, amounts[i], { lock: true }),
      ),
    );

    expect(await readSettlement(registration.id)).toBe(500);
  });

  // Documents the CURRENT nest-rebuild gap: the sponsorship link/unlink/recalc
  // transactions in apps/api use withTxn (READ COMMITTED) WITHOUT the ADR-0001
  // FOR UPDATE lock, so the recompute drifts. When Phase-1 locking lands, this
  // will start passing → remove `.fails` and flip to a normal no-drift assertion.
  it.fails(
    "unlocked settlement recompute drifts under READ COMMITTED (ADR-0001 lock not ported)",
    async () => {
      const amounts = [300, 200];
      const { registration, sponsorships } = await seedRegAndSponsors(amounts);
      const barrier = makeBarrier(amounts.length);

      await Promise.all(
        sponsorships.map((s, i) =>
          settleLink(registration.id, s.id, amounts[i], { lock: false, barrier }),
        ),
      );

      // Without the lock the last writer clobbers: final is one partial (300 or
      // 200), never the 500 sum. This assertion fails → `.fails` marks it green.
      expect(await readSettlement(registration.id)).toBe(500);
    },
  );
});
