import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  abstractCommitteeMemberships,
  abstractReviews,
  abstracts,
  assignReviewersTxn,
  deactivateCommitteeMembershipTxn,
  getDb,
  pgErrorCode,
  upsertCommitteeMembership,
  withTxn,
} from "@app/db";
import { setTimeout as sleep } from "node:timers/promises";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedAbstract, seedEvent, seedUser } from "../helpers/factories";

// Plan 2.9 follow-up: assigning a member while the same member is removed.
// assignReviewersTxn locks the chosen reviewers' memberships before the
// abstract, the order deactivateCommitteeMembershipTxn takes them in
// (membership UPDATE, then the abstracts it recomputes). Whichever commits
// first, an inactive member never ends up holding an active review, and the
// two queue instead of deadlocking.
//
// To race deterministically, one side is parked mid-transaction on an
// abstract row lock held by a separate transaction.

type Seeded = Awaited<ReturnType<typeof seedEvent>>;

async function seedMember(event: Seeded) {
  const user = await seedUser({ clientId: event.clientId });
  await upsertCommitteeMembership(event.id, user.id);
  return user;
}

/** True when `promise` settles within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true, () => true), sleep(ms).then(() => false)]);
}

/** True when another transaction holds a row lock on the membership. */
async function membershipLockHeld(eventId: string, userId: string): Promise<boolean> {
  try {
    await withTxn((tx) =>
      tx.execute(
        sql`SELECT id FROM abstract_committee_memberships WHERE event_id = ${eventId} AND user_id = ${userId} FOR UPDATE NOWAIT`,
      ),
    );
    return false;
  } catch (error) {
    if (pgErrorCode(error) === "55P03") return true;
    throw error;
  }
}

async function waitForMembershipLock(eventId: string, userId: string): Promise<void> {
  await vi.waitFor(async () => expect(await membershipLockHeld(eventId, userId)).toBe(true), {
    timeout: 10_000,
    interval: 50,
  });
}

/** Hold a row lock on the abstract in a separate transaction until `release()`. */
async function holdAbstractLock(abstractId: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const lockTaken = new Promise<void>((resolve) => (locked = resolve));
  const holder = withTxn(async (tx) => {
    await tx.execute(sql`SELECT id FROM abstracts WHERE id = ${abstractId} FOR UPDATE`);
    locked();
    await released;
  });
  await Promise.race([lockTaken, holder]);
  return {
    release: async () => {
      release();
      await holder;
    },
  };
}

async function readReviews(abstractId: string) {
  const rows = await getDb()
    .select({ reviewerId: abstractReviews.reviewerId, active: abstractReviews.active })
    .from(abstractReviews)
    .where(eq(abstractReviews.abstractId, abstractId));
  return rows.sort((a, b) => a.reviewerId.localeCompare(b.reviewerId));
}

/** Abstract ids on which the user holds an active review in the event. */
async function activeReviewAbstractIds(eventId: string, userId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ abstractId: abstractReviews.abstractId })
    .from(abstractReviews)
    .where(
      and(
        eq(abstractReviews.eventId, eventId),
        eq(abstractReviews.reviewerId, userId),
        eq(abstractReviews.active, true),
      ),
    );
  return rows.map((r) => r.abstractId).sort();
}

async function membershipActive(eventId: string, userId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ active: abstractCommitteeMemberships.active })
    .from(abstractCommitteeMemberships)
    .where(
      and(
        eq(abstractCommitteeMemberships.eventId, eventId),
        eq(abstractCommitteeMemberships.userId, userId),
      ),
    );
  return row!.active;
}

async function readAggregate(abstractId: string) {
  const [row] = await getDb()
    .select({ status: abstracts.status, reviewCount: abstracts.reviewCount })
    .from(abstracts)
    .where(eq(abstracts.id, abstractId));
  return row!;
}

describe.runIf(dbTestsEnabled())("concurrency: reviewer assignment against a member's removal", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it("an assignment waiting on a removal in flight is refused and writes no review", async () => {
    const event = await seedEvent({ status: "OPEN" });
    const leaver = await seedMember(event);
    const stayerA = await seedMember(event);
    const stayerB = await seedMember(event);
    const reviewed = await seedAbstract({ eventId: event.id, status: "SUBMITTED" });
    const target = await seedAbstract({ eventId: event.id, status: "SUBMITTED" });
    expect(
      await assignReviewersTxn({
        eventId: event.id,
        abstractId: reviewed.id,
        reviewerIds: [leaver.id, stayerA.id],
      }),
    ).toMatchObject({ ok: true });

    // The removal takes the membership row, then parks on `reviewed`.
    const holder = await holdAbstractLock(reviewed.id);
    let removal: Promise<void> | undefined;
    let late: ReturnType<typeof assignReviewersTxn> | undefined;
    try {
      removal = deactivateCommitteeMembershipTxn(event.id, leaver.id);
      await waitForMembershipLock(event.id, leaver.id);
      expect(await settlesWithin(removal, 200)).toBe(false);

      late = assignReviewersTxn({
        eventId: event.id,
        abstractId: target.id,
        reviewerIds: [leaver.id, stayerB.id],
      });
      expect(await settlesWithin(late, 300)).toBe(false);
    } finally {
      await holder.release();
    }

    await removal;
    expect(await late).toEqual({ ok: false, reason: "inactive_member", reviewerIds: [leaver.id] });
    expect(await membershipActive(event.id, leaver.id)).toBe(false);
    expect(await activeReviewAbstractIds(event.id, leaver.id)).toEqual([]);
    expect(await readReviews(target.id)).toEqual([]);
    expect(await readAggregate(target.id)).toEqual({ status: "SUBMITTED", reviewCount: 0 });
  });

  it("a removal waiting on an assignment in flight deactivates the new review", async () => {
    const event = await seedEvent({ status: "OPEN" });
    const leaver = await seedMember(event);
    const stayer = await seedMember(event);
    const target = await seedAbstract({ eventId: event.id, status: "SUBMITTED" });

    // The assignment takes both memberships, then parks on `target`.
    const holder = await holdAbstractLock(target.id);
    let assignment: ReturnType<typeof assignReviewersTxn> | undefined;
    let removal: Promise<void> | undefined;
    try {
      assignment = assignReviewersTxn({
        eventId: event.id,
        abstractId: target.id,
        reviewerIds: [stayer.id, leaver.id],
      });
      await waitForMembershipLock(event.id, leaver.id);
      expect(await settlesWithin(assignment, 200)).toBe(false);

      removal = deactivateCommitteeMembershipTxn(event.id, leaver.id);
      expect(await settlesWithin(removal, 300)).toBe(false);
    } finally {
      await holder.release();
    }

    expect(await assignment).toMatchObject({ ok: true, status: "UNDER_REVIEW" });
    await removal;
    expect(await membershipActive(event.id, leaver.id)).toBe(false);
    expect(await activeReviewAbstractIds(event.id, leaver.id)).toEqual([]);
    const reviews = await readReviews(target.id);
    expect(reviews).toHaveLength(2);
    expect(reviews.find((r) => r.reviewerId === leaver.id)?.active).toBe(false);
    expect(reviews.find((r) => r.reviewerId === stayer.id)?.active).toBe(true);
    expect(await readAggregate(target.id)).toEqual({ status: "UNDER_REVIEW", reviewCount: 0 });
  });

  it("parallel assignments and a removal: no deadlock and no active review for the removed member", async () => {
    const event = await seedEvent({ status: "OPEN" });
    const leaver = await seedMember(event);
    const stayerA = await seedMember(event);
    const stayerB = await seedMember(event);
    const targets = await Promise.all(
      Array.from({ length: 6 }, () => seedAbstract({ eventId: event.id, status: "SUBMITTED" })),
    );

    // Overlapping reviewer sets in both input orders; memberships are locked
    // in ascending user id order whatever the input order.
    const assignments = targets.map((target, i) =>
      assignReviewersTxn({
        eventId: event.id,
        abstractId: target.id,
        reviewerIds: i % 2 === 0 ? [leaver.id, stayerA.id] : [stayerB.id, leaver.id],
      }),
    );
    const [results] = await Promise.all([
      Promise.all(assignments),
      deactivateCommitteeMembershipTxn(event.id, leaver.id),
    ]);

    for (const result of results) {
      if (!result.ok) {
        expect(result).toEqual({ ok: false, reason: "inactive_member", reviewerIds: [leaver.id] });
      }
    }
    expect(await membershipActive(event.id, leaver.id)).toBe(false);
    expect(await activeReviewAbstractIds(event.id, leaver.id)).toEqual([]);
    for (const [i, target] of targets.entries()) {
      const stayer = i % 2 === 0 ? stayerA : stayerB;
      const assigned = results[i]!.ok;
      const reviews = await readReviews(target.id);
      expect(reviews.filter((r) => r.active).map((r) => r.reviewerId)).toEqual(assigned ? [stayer.id] : []);
    }
  });
});
