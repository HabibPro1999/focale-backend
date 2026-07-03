import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  abstractReviews,
  abstracts,
  getDb,
  reviewAbstractTxn,
  withTxn,
  type DbExecutor,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import { makeBarrier } from "../helpers/barrier";
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
  opts: { lock: boolean; barrier?: () => Promise<void> },
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
    if (opts.barrier) await opts.barrier();
    await tx.update(abstracts).set({ averageScore, reviewCount }).where(eq(abstracts.id, abstractId));
  });
}

async function seedAbstractWithReviewers(count: number) {
  const event = await seedEvent({ status: "OPEN" });
  const abstract = await seedAbstract({ eventId: event.id });
  const reviewers = await Promise.all(
    Array.from({ length: count }, () => seedUser({ clientId: event.clientId })),
  );
  return { event, abstract, reviewerIds: reviewers.map((r) => r.id) };
}

async function readAggregate(abstractId: string) {
  const [row] = await getDb()
    .select({ reviewCount: abstracts.reviewCount, averageScore: abstracts.averageScore })
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

  // Documents the CURRENT gap using the exact recompute body, with a barrier to
  // make the READ COMMITTED lost-update deterministic. Flip to a normal
  // no-drift assertion (remove `.fails`) when the ADR-0001 lock lands.
  it.fails(
    "unlocked score recompute drifts under READ COMMITTED (ADR-0001 lock not ported)",
    async () => {
      const scores = [4, 8];
      const { event, abstract, reviewerIds } = await seedAbstractWithReviewers(scores.length);
      const barrier = makeBarrier(scores.length);

      await Promise.all(
        reviewerIds.map((rid, i) =>
          scoreReview(abstract.id, event.id, rid, scores[i], { lock: false, barrier }),
        ),
      );

      // Each txn saw only its own review → last writer wins with reviewCount 1.
      expect((await readAggregate(abstract.id)).reviewCount).toBe(scores.length);
    },
  );

  // Same drift against the LIVE @app/db fn (no barrier — genuine parallel workers).
  // reviewAbstractTxn runs withTxn (READ COMMITTED) and takes no abstract lock, so
  // the aggregate lost-updates. Reproduces every run at this fan-out (probed 15/15
  // at 6 reviewers). `.fails` → green now; goes red (remove `.fails`) once the
  // real fn takes the ADR-0001 lock.
  it.fails(
    "live reviewAbstractTxn lost-updates the aggregate under parallel scoring (ADR-0001 lock not ported)",
    async () => {
      const fanout = 8;
      const { event, abstract, reviewerIds } = await seedAbstractWithReviewers(fanout);

      await Promise.all(
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

      expect((await readAggregate(abstract.id)).reviewCount).toBe(fanout);
    },
  );
});
