import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  abstractReviews,
  abstracts,
  assignReviewersTxn,
  deactivateCommitteeMembershipTxn,
  finalizeAbstractTxn,
  getDb,
  reviewAbstractTxn,
  upsertCommitteeMembership,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedAbstract, seedEvent, seedUser } from "../helpers/factories";

async function readAbstract(abstractId: string) {
  const [row] = await getDb()
    .select({
      status: abstracts.status,
      averageScore: abstracts.averageScore,
      reviewCount: abstracts.reviewCount,
    })
    .from(abstracts)
    .where(eq(abstracts.id, abstractId));
  return row;
}

describe.runIf(dbTestsEnabled())("db tier: review aggregate recompute", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  // H8: assignReviewersTxn's closing update wrote only { status }, never
  // recomputing averageScore/reviewCount — so a removed reviewer's already-
  // counted score kept dragging the stored average even after they were taken
  // off the abstract.
  it("H8: removing a scored reviewer drops their score from averageScore/reviewCount", async () => {
    const event = await seedEvent({ status: "OPEN" });
    const abstract = await seedAbstract({ eventId: event.id, status: "SUBMITTED" });
    const r1 = await seedUser({ clientId: event.clientId });
    const r2 = await seedUser({ clientId: event.clientId });

    await assignReviewersTxn({
      eventId: event.id,
      abstractId: abstract.id,
      reviewerIds: [r1.id, r2.id],
      currentStatus: "SUBMITTED",
    });
    await reviewAbstractTxn({
      abstractId: abstract.id,
      eventId: event.id,
      reviewerId: r1.id,
      clientId: event.clientId,
      score: 10,
      comment: null,
      commentsEnabled: false,
      divergenceThreshold: 1000,
    });
    await reviewAbstractTxn({
      abstractId: abstract.id,
      eventId: event.id,
      reviewerId: r2.id,
      clientId: event.clientId,
      score: 20,
      comment: null,
      commentsEnabled: false,
      divergenceThreshold: 1000,
    });

    expect(await readAbstract(abstract.id)).toMatchObject({
      status: "REVIEW_COMPLETE",
      averageScore: 15,
      reviewCount: 2,
    });

    // Remove r2 by re-assigning with only r1.
    await assignReviewersTxn({
      eventId: event.id,
      abstractId: abstract.id,
      reviewerIds: [r1.id],
      currentStatus: "REVIEW_COMPLETE",
    });

    expect(await readAbstract(abstract.id)).toMatchObject({
      status: "REVIEW_COMPLETE",
      averageScore: 10,
      reviewCount: 1,
    });
  });

  // M16: a post-divergence extra (tie-breaker) reviewer added to an already
  // REVIEW_COMPLETE abstract left status untouched, so the abstract stayed
  // "complete" (and financeable) despite an unscored active review.
  it("M16: assigning a new unscored reviewer falls a stale REVIEW_COMPLETE back to UNDER_REVIEW", async () => {
    const event = await seedEvent({ status: "OPEN" });
    const abstract = await seedAbstract({ eventId: event.id, status: "SUBMITTED" });
    const r1 = await seedUser({ clientId: event.clientId });
    const r2 = await seedUser({ clientId: event.clientId });
    const tieBreaker = await seedUser({ clientId: event.clientId });

    await assignReviewersTxn({
      eventId: event.id,
      abstractId: abstract.id,
      reviewerIds: [r1.id, r2.id],
      currentStatus: "SUBMITTED",
    });
    await reviewAbstractTxn({
      abstractId: abstract.id,
      eventId: event.id,
      reviewerId: r1.id,
      clientId: event.clientId,
      score: 5,
      comment: null,
      commentsEnabled: false,
      divergenceThreshold: 1000,
    });
    await reviewAbstractTxn({
      abstractId: abstract.id,
      eventId: event.id,
      reviewerId: r2.id,
      clientId: event.clientId,
      score: 20,
      comment: null,
      commentsEnabled: false,
      divergenceThreshold: 1000,
    });
    expect((await readAbstract(abstract.id)).status).toBe("REVIEW_COMPLETE");

    const result = await assignReviewersTxn({
      eventId: event.id,
      abstractId: abstract.id,
      reviewerIds: [r1.id, r2.id, tieBreaker.id],
      currentStatus: "REVIEW_COMPLETE",
    });

    expect(result.status).toBe("UNDER_REVIEW");
    expect((await readAbstract(abstract.id)).status).toBe("UNDER_REVIEW");
  });

  // M15: removing a committee member left their abstractReviews rows active,
  // so an already-submitted score kept counting forever and an unscored
  // assignment permanently blocked REVIEW_COMPLETE.
  it("M15: deactivating a committee member excludes their score and unblocks REVIEW_COMPLETE", async () => {
    const event = await seedEvent({ status: "OPEN" });
    const abstract = await seedAbstract({ eventId: event.id, status: "SUBMITTED" });
    const r1 = await seedUser({ clientId: event.clientId });
    const r2 = await seedUser({ clientId: event.clientId });
    await upsertCommitteeMembership(event.id, r1.id);
    await upsertCommitteeMembership(event.id, r2.id);

    await assignReviewersTxn({
      eventId: event.id,
      abstractId: abstract.id,
      reviewerIds: [r1.id, r2.id],
      currentStatus: "SUBMITTED",
    });
    await reviewAbstractTxn({
      abstractId: abstract.id,
      eventId: event.id,
      reviewerId: r1.id,
      clientId: event.clientId,
      score: 10,
      comment: null,
      commentsEnabled: false,
      divergenceThreshold: 1000,
    });
    // r2 is assigned but has NOT scored yet: blocks REVIEW_COMPLETE.
    expect((await readAbstract(abstract.id)).status).toBe("UNDER_REVIEW");

    await deactivateCommitteeMembershipTxn(event.id, r2.id);

    const after = await readAbstract(abstract.id);
    expect(after.reviewCount).toBe(1);
    expect(after.averageScore).toBe(10);
    // r2's unscored assignment no longer blocks completion.
    expect(after.status).toBe("REVIEW_COMPLETE");
  });

  // M15 guard: offboarding a member must NOT rewrite the decision record of an
  // already-finalized abstract — review rows stay active (they are the inputs
  // the decision was made on) and averageScore/reviewCount/status are frozen.
  it("M15: deactivating a member leaves finalized abstracts' reviews and aggregates untouched", async () => {
    const event = await seedEvent({ status: "OPEN" });
    const abstract = await seedAbstract({ eventId: event.id, status: "SUBMITTED" });
    const r1 = await seedUser({ clientId: event.clientId });
    const r2 = await seedUser({ clientId: event.clientId });
    await upsertCommitteeMembership(event.id, r1.id);
    await upsertCommitteeMembership(event.id, r2.id);

    await assignReviewersTxn({
      eventId: event.id,
      abstractId: abstract.id,
      reviewerIds: [r1.id, r2.id],
      currentStatus: "SUBMITTED",
    });
    for (const [reviewer, score] of [
      [r1, 10],
      [r2, 20],
    ] as const) {
      await reviewAbstractTxn({
        abstractId: abstract.id,
        eventId: event.id,
        reviewerId: reviewer.id,
        clientId: event.clientId,
        score,
        comment: null,
        commentsEnabled: false,
        divergenceThreshold: 1000,
      });
    }
    const result = await finalizeAbstractTxn({
      eventId: event.id,
      abstractId: abstract.id,
      decision: "REJECTED",
      performedBy: "test-admin",
    });
    expect(result.ok).toBe(true);

    await deactivateCommitteeMembershipTxn(event.id, r1.id);

    const after = await readAbstract(abstract.id);
    expect(after.status).toBe("REJECTED");
    expect(after.averageScore).toBe(15);
    expect(after.reviewCount).toBe(2);
    const [r1Review] = await getDb()
      .select({ active: abstractReviews.active })
      .from(abstractReviews)
      .where(
        and(
          eq(abstractReviews.abstractId, abstract.id),
          eq(abstractReviews.reviewerId, r1.id),
        ),
      );
    expect(r1Review.active).toBe(true);
  });
});
