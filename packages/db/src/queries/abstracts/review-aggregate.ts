/**
 * Review aggregate recompute shared by review submission, reviewer assignment
 * and membership deactivation. Module-internal: the `../abstracts` barrel
 * does not re-export it.
 */
import { and, eq, notInArray } from "drizzle-orm";
import { FINAL_STATUSES } from "@app/contracts";
import type { DbExecutor } from "../../client";
import { abstractReviews, abstracts } from "../../schema/abstracts";
import type { AbstractRow } from "./shared";

/**
 * Aggregate an abstract's remaining ACTIVE reviews into averageScore/
 * reviewCount/allScored. Shared by reviewAbstractTxn, assignReviewersTxn
 * (H8/M16), and deactivateCommitteeMembershipTxn (M15) so a reviewer-set
 * change never leaves stale aggregates behind.
 */
export async function computeReviewAggregate(
  tx: DbExecutor,
  abstractId: string,
): Promise<{
  averageScore: number | null;
  reviewCount: number;
  allScored: boolean;
  scores: number[];
}> {
  const assignments = await tx
    .select({ scoredAt: abstractReviews.scoredAt, score: abstractReviews.score })
    .from(abstractReviews)
    .where(
      and(eq(abstractReviews.abstractId, abstractId), eq(abstractReviews.active, true)),
    );
  const scores = assignments
    .map((r) => r.score)
    .filter((s): s is number => s !== null);
  const reviewCount = assignments.filter((r) => r.scoredAt !== null).length;
  const averageScore = scores.length
    ? scores.reduce((sum, s) => sum + s, 0) / scores.length
    : null;
  const allScored =
    assignments.length > 0 && assignments.every((r) => r.scoredAt !== null);
  return { averageScore, reviewCount, allScored, scores };
}

/**
 * Derive the post-recompute status. Never overrides a terminal decision
 * (FINAL_STATUSES); otherwise preserves the SUBMITTED->UNDER_REVIEW
 * transition on first assignment (`hasReviewers`), advances to
 * REVIEW_COMPLETE once every active review is scored, and — the M16 fix —
 * falls a stale REVIEW_COMPLETE back to UNDER_REVIEW the moment that stops
 * being true (e.g. a post-divergence extra reviewer was just added unscored).
 */
export function deriveReviewStatus(
  currentStatus: AbstractRow["status"],
  hasReviewers: boolean,
  allScored: boolean,
): AbstractRow["status"] {
  if (FINAL_STATUSES.includes(currentStatus)) return currentStatus;
  const base =
    hasReviewers && currentStatus === "SUBMITTED" ? "UNDER_REVIEW" : currentStatus;
  if (allScored) return "REVIEW_COMPLETE";
  return base === "REVIEW_COMPLETE" ? "UNDER_REVIEW" : base;
}

/**
 * Recompute + write averageScore/reviewCount/status for one abstract. The
 * caller holds the abstract's row lock; the status is read here, after it.
 * No-op on finalized abstracts: the stored aggregate is part of the decision
 * record and must never be rewritten after the fact (deriveReviewStatus
 * already refuses to move a terminal status; this extends the same rule to
 * the score fields).
 */
export async function applyReviewAggregate(
  tx: DbExecutor,
  abstractId: string,
  hasReviewers: boolean,
): Promise<{ id: string; status: AbstractRow["status"] }> {
  const [current] = await tx
    .select({ status: abstracts.status })
    .from(abstracts)
    .where(eq(abstracts.id, abstractId))
    .limit(1);
  if (!current) throw lockedAbstractChanged(abstractId);
  if (FINAL_STATUSES.includes(current.status)) {
    return { id: abstractId, status: current.status };
  }
  const { averageScore, reviewCount, allScored } = await computeReviewAggregate(
    tx,
    abstractId,
  );
  const status = deriveReviewStatus(current.status, hasReviewers, allScored);
  const [updated] = await tx
    .update(abstracts)
    .set({ averageScore, reviewCount, status })
    .where(
      and(
        eq(abstracts.id, abstractId),
        notInArray(abstracts.status, FINAL_STATUSES),
      ),
    )
    .returning({ id: abstracts.id, status: abstracts.status });
  if (!updated) throw lockedAbstractChanged(abstractId);
  return updated;
}

/**
 * A row the caller locked changed under the lock. Unreachable while callers
 * lock first; thrown (not returned) so the transaction rolls back.
 */
export function lockedAbstractChanged(abstractId: string): Error {
  return new Error(`Abstract ${abstractId} changed while its row lock was held`);
}
