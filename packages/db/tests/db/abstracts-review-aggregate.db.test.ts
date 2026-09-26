import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  abstractReviews,
  abstractRevisions,
  abstracts,
  assignReviewersTxn,
  deactivateCommitteeMembershipTxn,
  editAbstractTxn,
  finalizeAbstractTxn,
  getDb,
  reviewAbstractTxn,
  upsertCommitteeMembership,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedAbstract, seedEvent, seedUser, testAudit } from "../helpers/factories";

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
    await upsertCommitteeMembership(event.id, r1.id);
    await upsertCommitteeMembership(event.id, r2.id);

    await assignReviewersTxn({
      eventId: event.id,
      abstractId: abstract.id,
      reviewerIds: [r1.id, r2.id],
      audit: testAudit(),
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
      audit: testAudit(),
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
    for (const member of [r1, r2, tieBreaker]) await upsertCommitteeMembership(event.id, member.id);

    await assignReviewersTxn({
      eventId: event.id,
      abstractId: abstract.id,
      reviewerIds: [r1.id, r2.id],
      audit: testAudit(),
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
      audit: testAudit(),
    });

    expect(result).toMatchObject({ ok: true, status: "UNDER_REVIEW" });
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
      audit: testAudit(),
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

    await deactivateCommitteeMembershipTxn(event.id, r2.id, testAudit());

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
      audit: testAudit(),
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

    await deactivateCommitteeMembershipTxn(event.id, r1.id, testAudit());

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

async function readReviews(abstractId: string) {
  const rows = await getDb()
    .select({
      reviewerId: abstractReviews.reviewerId,
      active: abstractReviews.active,
      score: abstractReviews.score,
    })
    .from(abstractReviews)
    .where(eq(abstractReviews.abstractId, abstractId));
  return rows.sort((a, b) => a.reviewerId.localeCompare(b.reviewerId));
}

function score(abstractId: string, eventId: string, clientId: string, reviewerId: string, value: number) {
  return reviewAbstractTxn({
    abstractId,
    eventId,
    reviewerId,
    clientId,
    score: value,
    comment: null,
    commentsEnabled: false,
    divergenceThreshold: 1000,
  });
}

// Plan 2.9: the transactions decide from the status and assignments they read
// after locking the abstract, not from the caller's earlier read.
describe.runIf(dbTestsEnabled())("db tier: abstract final-status guards", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  async function seedReviewed() {
    const event = await seedEvent({ status: "OPEN" });
    const abstract = await seedAbstract({ eventId: event.id, status: "SUBMITTED" });
    const r1 = await seedUser({ clientId: event.clientId });
    const r2 = await seedUser({ clientId: event.clientId });
    const r3 = await seedUser({ clientId: event.clientId });
    for (const member of [r1, r2, r3]) await upsertCommitteeMembership(event.id, member.id);
    expect(
      await assignReviewersTxn({ eventId: event.id, abstractId: abstract.id, reviewerIds: [r1.id, r2.id], audit: testAudit() }),
    ).toMatchObject({ ok: true, status: "UNDER_REVIEW" });
    expect(await score(abstract.id, event.id, event.clientId, r1.id, 12)).toMatchObject({ ok: true });
    return { event, abstract, r1, r2, r3 };
  }

  it("review of a finalized abstract returns finalized and writes nothing", async () => {
    const { event, abstract, r2 } = await seedReviewed();
    expect(
      await finalizeAbstractTxn({
        eventId: event.id,
        abstractId: abstract.id,
        decision: "REJECTED",
        finalType: undefined,
        performedBy: "test-admin",
      }),
    ).toEqual({ ok: true });
    const before = await readReviews(abstract.id);

    expect(await score(abstract.id, event.id, event.clientId, r2.id, 4)).toEqual({
      ok: false,
      reason: "finalized",
    });

    expect(await readReviews(abstract.id)).toEqual(before);
    expect(await readAbstract(abstract.id)).toEqual({ status: "REJECTED", averageScore: 12, reviewCount: 1 });
  });

  it("a removed or never-assigned reviewer can't score, and no review row is created", async () => {
    const { event, abstract, r1, r2, r3 } = await seedReviewed();
    // Re-assigning without r2 deactivates r2's review.
    expect(
      await assignReviewersTxn({ eventId: event.id, abstractId: abstract.id, reviewerIds: [r1.id], audit: testAudit() }),
    ).toMatchObject({ ok: true });
    const before = await readReviews(abstract.id);
    const aggregate = await readAbstract(abstract.id);

    for (const reviewer of [r2, r3]) {
      expect(await score(abstract.id, event.id, event.clientId, reviewer.id, 1)).toEqual({
        ok: false,
        reason: "not_assigned",
      });
    }

    expect(await readReviews(abstract.id)).toEqual(before);
    expect(await readAbstract(abstract.id)).toEqual(aggregate);
  });

  it("reviews derive the status: SUBMITTED moves to UNDER_REVIEW, then REVIEW_COMPLETE", async () => {
    const event = await seedEvent({ status: "OPEN" });
    const abstract = await seedAbstract({ eventId: event.id, status: "SUBMITTED" });
    const r1 = await seedUser({ clientId: event.clientId });
    const r2 = await seedUser({ clientId: event.clientId });
    // Assignment rows written without the status move (e.g. before the port).
    await getDb().insert(abstractReviews).values([
      { abstractId: abstract.id, eventId: event.id, reviewerId: r1.id, active: true },
      { abstractId: abstract.id, eventId: event.id, reviewerId: r2.id, active: true },
    ]);

    expect(await score(abstract.id, event.id, event.clientId, r1.id, 10)).toMatchObject({
      ok: true,
      status: "UNDER_REVIEW",
      reviewCount: 1,
    });
    expect(await score(abstract.id, event.id, event.clientId, r2.id, 20)).toMatchObject({
      ok: true,
      status: "REVIEW_COMPLETE",
      averageScore: 15,
      reviewCount: 2,
    });
  });

  it("assignment on a finalized abstract returns finalized and leaves its reviewers alone", async () => {
    const { event, abstract, r1, r3 } = await seedReviewed();
    expect(
      await finalizeAbstractTxn({
        eventId: event.id,
        abstractId: abstract.id,
        decision: "PENDING",
        finalType: undefined,
        performedBy: "test-admin",
      }),
    ).toEqual({ ok: true });
    const before = await readReviews(abstract.id);

    expect(
      await assignReviewersTxn({ eventId: event.id, abstractId: abstract.id, reviewerIds: [r1.id, r3.id], audit: testAudit() }),
    ).toEqual({ ok: false, reason: "finalized" });

    expect(await readReviews(abstract.id)).toEqual(before);
    expect((await readAbstract(abstract.id)).status).toBe("PENDING");
  });

  // 2.9 follow-up: the membership is re-read under its lock inside the txn.
  it("assignment of a removed or never-added member returns inactive_member and changes nothing", async () => {
    const { event, abstract, r1, r2, r3 } = await seedReviewed();
    const outsider = await seedUser({ clientId: event.clientId });
    await deactivateCommitteeMembershipTxn(event.id, r3.id, testAudit());
    const before = await readReviews(abstract.id);
    const aggregate = await readAbstract(abstract.id);

    expect(
      await assignReviewersTxn({
        eventId: event.id,
        abstractId: abstract.id,
        reviewerIds: [r1.id, r2.id, r3.id, outsider.id],
        audit: testAudit(),
      }),
    ).toEqual({ ok: false, reason: "inactive_member", reviewerIds: [r3.id, outsider.id] });

    expect(await readReviews(abstract.id)).toEqual(before);
    expect(await readAbstract(abstract.id)).toEqual(aggregate);
  });

  it("assignment of another event's abstract returns not_found", async () => {
    const { abstract, r1, r2 } = await seedReviewed();
    const otherEvent = await seedEvent({ status: "OPEN" });
    expect(
      await assignReviewersTxn({ eventId: otherEvent.id, abstractId: abstract.id, reviewerIds: [r1.id, r2.id], audit: testAudit() }),
    ).toEqual({ ok: false, reason: "not_found" });
  });

  it("edit of a finalized abstract returns not_editable and writes no revision", async () => {
    const { event, abstract } = await seedReviewed();
    expect(
      await finalizeAbstractTxn({
        eventId: event.id,
        abstractId: abstract.id,
        decision: "REJECTED",
        finalType: undefined,
        performedBy: "test-admin",
      }),
    ).toEqual({ ok: true });

    expect(
      await editAbstractTxn({
        id: abstract.id,
        authorFirstName: "Edited",
        authorLastName: abstract.authorLastName,
        authorAffiliation: abstract.authorAffiliation ?? "",
        authorEmail: abstract.authorEmail,
        authorEmailNormalized: abstract.authorEmail.toLowerCase(),
        authorPhone: abstract.authorPhone,
        requestedType: abstract.requestedType,
        content: { body: "late edit" },
        coAuthors: [],
        additionalFieldsData: {},
        registrationId: null,
        themeIds: [],
        revisionSnapshot: { body: "late edit" },
        lastEditedAt: new Date(),
      }),
    ).toEqual({ ok: false, reason: "not_editable" });

    const [row] = await getDb()
      .select({ authorFirstName: abstracts.authorFirstName, contentVersion: abstracts.contentVersion })
      .from(abstracts)
      .where(eq(abstracts.id, abstract.id));
    expect(row).toEqual({ authorFirstName: abstract.authorFirstName, contentVersion: abstract.contentVersion });
    expect(
      await getDb().select().from(abstractRevisions).where(eq(abstractRevisions.abstractId, abstract.id)),
    ).toHaveLength(0);
  });
});
