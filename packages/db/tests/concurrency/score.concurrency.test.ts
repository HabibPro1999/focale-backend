import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  abstractReviews,
  abstracts,
  assignReviewersTxn,
  getDb,
  reviewAbstractTxn,
  withTxn,
  type DbExecutor,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedAbstract, seedEvent, seedUser } from "../helpers/factories";

// Score aggregation. Submitting a review recomputes abstracts.review_count and
// average_score from ALL active reviews (recompute-from-children) — the exact
// pattern ADR-0001 flags. Without a FOR UPDATE lock on the abstract, concurrent
// reviewers each read only their own uncommitted review row under READ COMMITTED
// and the last writer clobbers the aggregate.
//
// `scoreReview` mirrors reviewAbstractTxn's insert→read-all→recompute→write body,
// re-expressed against the @app/db tables; `lock` toggles the ADR-0001 remedy.
async function scoreReview(
  abstractId: string,
  eventId: string,
  reviewerId: string,
  score: number,
  opts: { lock: boolean },
): Promise<void> {
  await withTxn(async (tx: DbExecutor) => {
    if (opts.lock) {
      await tx.execute(
        sql`SELECT id FROM abstracts WHERE id = ${abstractId} FOR UPDATE`,
      );
    }
    await tx
      .insert(abstractReviews)
      .values({ abstractId, eventId, reviewerId, active: true, score, scoredAt: new Date() })
      .onConflictDoUpdate({
        target: [abstractReviews.abstractId, abstractReviews.reviewerId],
        set: { eventId, active: true, score, scoredAt: new Date() },
      });
    const rows = await tx
      .select({ scoredAt: abstractReviews.scoredAt, score: abstractReviews.score })
      .from(abstractReviews)
      .where(and(eq(abstractReviews.abstractId, abstractId), eq(abstractReviews.active, true)));
    const scores = rows.map((r) => r.score).filter((s): s is number => s !== null);
    const reviewCount = rows.filter((r) => r.scoredAt !== null).length;
    const averageScore = scores.length
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : null;
    await tx.update(abstracts).set({ averageScore, reviewCount }).where(eq(abstracts.id, abstractId));
  });
}

async function seedAbstractWithReviewers(count: number) {
  const event = await seedEvent({ status: "OPEN" });
  const abstract = await seedAbstract({ eventId: event.id });
  const reviewers = await Promise.all(
    Array.from({ length: count }, () => seedUser({ clientId: event.clientId })),
  );
  const reviewerIds = reviewers.map((r) => r.id);
  // reviewAbstractTxn scores active assignments only.
  expect(await assignReviewersTxn({ eventId: event.id, abstractId: abstract.id, reviewerIds }))
    .toMatchObject({ ok: true });
  return { event, abstract, reviewerIds };
}

async function readAggregate(abstractId: string) {
  const [row] = await getDb()
    .select({
      reviewCount: abstracts.reviewCount,
      averageScore: abstracts.averageScore,
      status: abstracts.status,
    })
    .from(abstracts)
    .where(eq(abstracts.id, abstractId));
  return row;
}

describe.runIf(dbTestsEnabled())("concurrency: score aggregation drift", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it("FOR UPDATE lock serializes score recompute (ADR-0001 remedy — no drift)", async () => {
    const scores = [1, 2, 3, 4, 5];
    const { event, abstract, reviewerIds } = await seedAbstractWithReviewers(scores.length);

    await Promise.all(
      reviewerIds.map((rid, i) =>
        scoreReview(abstract.id, event.id, rid, scores[i], { lock: true }),
      ),
    );

    const agg = await readAggregate(abstract.id);
    expect(agg.reviewCount).toBe(scores.length);
    expect(agg.averageScore).toBe(3);
  });

  // The live fn locks the abstract first (plan 2.9), so parallel reviewers
  // queue on its row and each recompute sees every committed score. Before
  // the lock this lost updates every run at this fan-out (probed 15/15 at 6).
  it("live reviewAbstractTxn keeps the aggregate exact under parallel scoring", async () => {
    const fanout = 8;
    const { event, abstract, reviewerIds } = await seedAbstractWithReviewers(fanout);

    const results = await Promise.all(
      reviewerIds.map((rid, i) =>
        reviewAbstractTxn({
          abstractId: abstract.id,
          eventId: event.id,
          reviewerId: rid,
          clientId: event.clientId,
          score: i + 1,
          comment: null,
          commentsEnabled: false,
          divergenceThreshold: 1000,
        }),
      ),
    );

    expect(results.every((r) => r.ok)).toBe(true);
    expect(await readAggregate(abstract.id)).toEqual({
      reviewCount: fanout,
      averageScore: (fanout + 1) / 2,
      status: "REVIEW_COMPLETE",
    });
  });
});
