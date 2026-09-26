/** Committee review submission: the review read, the score write and the divergence alert. */
import { and, eq, gte, notInArray } from "drizzle-orm";
import { UserRole, FINAL_STATUSES } from "@app/contracts";
import { getDb, type DbExecutor } from "../../client";
import { withLockingTxn } from "../../txn";
import { lockAbstractForUpdate } from "../../locks";
import { enqueueRealtimeOutboxEvent, insertAuditLog } from "../../outbox";
import { abstractConfig, abstractReviews, abstracts } from "../../schema/abstracts";
import { events } from "../../schema/events-access";
import { users } from "../../schema/users-clients";
import { emailLogs } from "../../schema/email";
import {
  computeReviewAggregate,
  deriveReviewStatus,
  lockedAbstractChanged,
} from "./review-aggregate";
import {
  enqueueAbstractEmailOutboxEvent,
  loadThemeRefs,
  type AbstractRow,
  type ThemeRef,
} from "./shared";

// ============================================================================
// Committee — review read
// ============================================================================

export interface AbstractForReview {
  id: string;
  eventId: string;
  status: AbstractRow["status"];
  clientId: string;
  config: {
    scoringStartAt: Date | null;
    scoringDeadline: Date | null;
    divergenceThreshold: number;
    commentsEnabled: boolean;
  } | null;
  themes: ThemeRef[];
  reviews: { reviewerId: string; active: boolean }[];
}

export async function findAbstractForReview(
  abstractId: string,
): Promise<AbstractForReview | null> {
  const [row] = await getDb()
    .select({
      id: abstracts.id,
      eventId: abstracts.eventId,
      status: abstracts.status,
      clientId: events.clientId,
    })
    .from(abstracts)
    .innerJoin(events, eq(abstracts.eventId, events.id))
    .where(eq(abstracts.id, abstractId))
    .limit(1);
  if (!row) return null;

  const [cfg] = await getDb()
    .select({
      scoringStartAt: abstractConfig.scoringStartAt,
      scoringDeadline: abstractConfig.scoringDeadline,
      divergenceThreshold: abstractConfig.divergenceThreshold,
      commentsEnabled: abstractConfig.commentsEnabled,
    })
    .from(abstractConfig)
    .where(eq(abstractConfig.eventId, row.eventId))
    .limit(1);

  const [themeMap, reviews] = await Promise.all([
    loadThemeRefs([abstractId]),
    getDb()
      .select({
        reviewerId: abstractReviews.reviewerId,
        active: abstractReviews.active,
      })
      .from(abstractReviews)
      .where(
        and(
          eq(abstractReviews.abstractId, abstractId),
          eq(abstractReviews.active, true),
        ),
      ),
  ]);

  return {
    ...row,
    config: cfg ?? null,
    themes: themeMap.get(abstractId) ?? [],
    reviews,
  };
}

// ============================================================================
// Committee — review submission (score aggregation + divergence)
// ============================================================================

const ONE_HOUR_MS = 60 * 60 * 1000;

async function notifyScoreDivergence(input: {
  db: DbExecutor;
  abstractId: string;
  eventId: string;
  clientId: string;
  averageScore: number | null;
  reviewCount: number;
  scores: number[];
  threshold: number;
}): Promise<void> {
  if (input.scores.length < 2) return;
  const min = Math.min(...input.scores);
  const max = Math.max(...input.scores);
  if (max - min <= 0 || max - min < input.threshold) return;

  const since = new Date(Date.now() - ONE_HOUR_MS);
  const [existing] = await input.db
    .select({ id: emailLogs.id })
    .from(emailLogs)
    .where(
      and(
        eq(emailLogs.abstractId, input.abstractId),
        eq(emailLogs.abstractTrigger, "ABSTRACT_SCORE_DIVERGENCE"),
        gte(emailLogs.queuedAt, since),
      ),
    )
    .limit(1);
  if (existing) return;

  const admins = await input.db
    .select({ email: users.email, name: users.name })
    .from(users)
    .where(
      and(
        eq(users.clientId, input.clientId),
        eq(users.role, UserRole.CLIENT_ADMIN),
        eq(users.active, true),
      ),
    );

  const dedupeBucket = Math.floor(Date.now() / ONE_HOUR_MS);
  // One statement at a time: these ride the caller's transaction, whose single
  // connection cannot run statements concurrently.
  for (const admin of admins) {
    await enqueueAbstractEmailOutboxEvent(
      input.db,
      {
        trigger: "ABSTRACT_SCORE_DIVERGENCE",
        abstractId: input.abstractId,
        recipientOverride: { email: admin.email, name: admin.name },
        extraContext: {
          averageScore: input.averageScore,
          reviewCount: input.reviewCount,
          minScore: min,
          maxScore: max,
          divergenceThreshold: input.threshold,
        },
      },
      `email:abstract:ABSTRACT_SCORE_DIVERGENCE:${input.abstractId}:${admin.email}:${dedupeBucket}`,
    );
  }

  await enqueueRealtimeOutboxEvent(input.db, {
    type: "abstract.scoreDiverged",
    clientId: input.clientId,
    eventId: input.eventId,
    payload: {
      id: input.abstractId,
      averageScore: input.averageScore,
      reviewCount: input.reviewCount,
      minScore: min,
      maxScore: max,
      divergenceThreshold: input.threshold,
    },
    ts: Date.now(),
  });
}

export type ReviewAbstractResult =
  | {
      ok: true;
      id: string;
      status: AbstractRow["status"];
      averageScore: number | null;
      reviewCount: number;
    }
  | { ok: false; reason: "not_found" | "finalized" | "not_assigned" };

export async function reviewAbstractTxn(params: {
  abstractId: string;
  eventId: string;
  reviewerId: string;
  clientId: string;
  score: number;
  comment: string | null | undefined;
  commentsEnabled: boolean;
  divergenceThreshold: number;
}): Promise<ReviewAbstractResult> {
  const {
    abstractId,
    eventId,
    reviewerId,
    clientId,
    score,
    commentsEnabled,
    divergenceThreshold,
  } = params;
  const commentValue = commentsEnabled === false ? null : (params.comment ?? null);

  // Lock first, then re-read (ADR 0001): parallel reviews of one abstract
  // queue on its row, so each recompute sees every committed score, and a
  // decision committed before the lock is seen here.
  return withLockingTxn(async (tx): Promise<ReviewAbstractResult> => {
    if (!(await lockAbstractForUpdate(tx, abstractId))) {
      return { ok: false, reason: "not_found" };
    }
    const [current] = await tx
      .select({ status: abstracts.status })
      .from(abstracts)
      .where(eq(abstracts.id, abstractId))
      .limit(1);
    if (!current) return { ok: false, reason: "not_found" };
    if (FINAL_STATUSES.includes(current.status)) {
      return { ok: false, reason: "finalized" };
    }

    // Only an active assignment can be scored: a reviewer removed since the
    // caller's check matches no row, and nothing is written.
    const [review] = await tx
      .update(abstractReviews)
      .set({ score, comment: commentValue, scoredAt: new Date() })
      .where(
        and(
          eq(abstractReviews.abstractId, abstractId),
          eq(abstractReviews.reviewerId, reviewerId),
          eq(abstractReviews.active, true),
        ),
      )
      .returning({ id: abstractReviews.id });
    if (!review) return { ok: false, reason: "not_assigned" };

    const { averageScore, reviewCount, allScored, scores } =
      await computeReviewAggregate(tx, abstractId);
    const status = deriveReviewStatus(current.status, true, allScored);

    const [updated] = await tx
      .update(abstracts)
      .set({ averageScore, reviewCount, status })
      .where(
        and(
          eq(abstracts.id, abstractId),
          notInArray(abstracts.status, FINAL_STATUSES),
        ),
      )
      .returning({
        id: abstracts.id,
        status: abstracts.status,
        averageScore: abstracts.averageScore,
        reviewCount: abstracts.reviewCount,
      });
    if (!updated) throw lockedAbstractChanged(abstractId);

    await insertAuditLog(
      {
        entityType: "AbstractReview",
        entityId: abstractId,
        action: "score",
        changes: { score: { old: null, new: score } },
        performedBy: reviewerId,
      },
      tx,
    );

    if (updated.status === "REVIEW_COMPLETE") {
      await enqueueRealtimeOutboxEvent(tx, {
        type: "abstract.reviewCompleted",
        clientId,
        eventId,
        payload: {
          id: updated.id,
          status: updated.status,
          averageScore: updated.averageScore,
          reviewCount: updated.reviewCount,
        },
        ts: Date.now(),
      });
    }

    await notifyScoreDivergence({
      db: tx,
      abstractId,
      eventId,
      clientId,
      averageScore: updated.averageScore,
      reviewCount: updated.reviewCount,
      scores,
      threshold: divergenceThreshold,
    });

    return { ok: true, ...updated };
  });
}
