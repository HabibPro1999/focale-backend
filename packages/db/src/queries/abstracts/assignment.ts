/** Committee reviewer assignment: its config reads, gates and the locked write. */
import { and, asc, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import { FINAL_STATUSES } from "@app/contracts";
import { getDb, type DbExecutor } from "../../client";
import { withLockingTxn } from "../../txn";
import { lockAbstractForUpdate } from "../../locks";
import {
  abstractCommitteeMemberships,
  abstractConfig,
  abstractReviews,
  abstracts,
} from "../../schema/abstracts";
import { applyReviewAggregate } from "./review-aggregate";
import type { AbstractRow } from "./shared";

// ============================================================================
// Committee — reviewer assignment
// ============================================================================

export async function findAbstractBasic(
  abstractId: string,
): Promise<{ id: string; eventId: string; status: AbstractRow["status"] } | null> {
  const [row] = await getDb()
    .select({
      id: abstracts.id,
      eventId: abstracts.eventId,
      status: abstracts.status,
    })
    .from(abstracts)
    .where(eq(abstracts.id, abstractId))
    .limit(1);
  return row ?? null;
}

export async function getCommitteeConfig(
  eventId: string,
): Promise<{ reviewersPerAbstract: number; divergenceThreshold: number } | null> {
  const [row] = await getDb()
    .select({
      reviewersPerAbstract: abstractConfig.reviewersPerAbstract,
      divergenceThreshold: abstractConfig.divergenceThreshold,
    })
    .from(abstractConfig)
    .where(eq(abstractConfig.eventId, eventId))
    .limit(1);
  return row ?? null;
}

/** Scores of active, scored reviews for an abstract (divergence gate input). */
export async function findScoredReviewScores(
  abstractId: string,
): Promise<number[]> {
  const rows = await getDb()
    .select({ score: abstractReviews.score })
    .from(abstractReviews)
    .where(
      and(
        eq(abstractReviews.abstractId, abstractId),
        eq(abstractReviews.active, true),
        isNotNull(abstractReviews.score),
      ),
    );
  return rows
    .map((r) => r.score)
    .filter((s): s is number => s !== null);
}

export async function findActiveMembershipUserIds(
  eventId: string,
  reviewerIds: string[],
): Promise<string[]> {
  if (reviewerIds.length === 0) return [];
  const rows = await getDb()
    .select({ userId: abstractCommitteeMemberships.userId })
    .from(abstractCommitteeMemberships)
    .where(
      and(
        eq(abstractCommitteeMemberships.eventId, eventId),
        inArray(abstractCommitteeMemberships.userId, reviewerIds),
        eq(abstractCommitteeMemberships.active, true),
      ),
    );
  return rows.map((r) => r.userId);
}

/**
 * Lock the event's committee membership rows of these users, in ascending user
 * id order, then return the ids whose membership is active, read after the
 * lock. A bare `SELECT id … FOR UPDATE` (not FOR SHARE: CockroachDB ignores
 * shared locks under SERIALIZABLE by default).
 *
 * Lock order is memberships → abstracts, the order
 * deactivateCommitteeMembershipTxn takes them in (its membership UPDATE, then
 * the abstracts it recomputes). So an assignment and a deactivation of the
 * same member queue: either the deactivation commits first and the
 * assignment sees the membership inactive, or the assignment commits first
 * and the deactivation's later read finds the new review and deactivates it.
 */
async function lockActiveCommitteeMemberIds(
  tx: DbExecutor,
  eventId: string,
  userIds: readonly string[],
): Promise<Set<string>> {
  const ordered = [...new Set(userIds)].sort();
  if (ordered.length === 0) return new Set();
  const scope = and(
    eq(abstractCommitteeMemberships.eventId, eventId),
    inArray(abstractCommitteeMemberships.userId, ordered),
  );
  await tx
    .select({ id: abstractCommitteeMemberships.id })
    .from(abstractCommitteeMemberships)
    .where(scope)
    .orderBy(asc(abstractCommitteeMemberships.userId))
    .for("update");
  const active = await tx
    .select({ userId: abstractCommitteeMemberships.userId })
    .from(abstractCommitteeMemberships)
    .where(and(scope, eq(abstractCommitteeMemberships.active, true)));
  return new Set(active.map((row) => row.userId));
}

export type AssignReviewersResult =
  | { ok: true; id: string; status: AbstractRow["status"] }
  | { ok: false; reason: "not_found" | "finalized" }
  | { ok: false; reason: "inactive_member"; reviewerIds: string[] };

/**
 * Replace an abstract's reviewer set and recompute its aggregate.
 *
 * Locks the chosen reviewers' memberships first, then the abstract, and
 * decides from what it reads after the locks: a finalized abstract's
 * reviewers are part of the decision record, so nothing changes; a reviewer
 * whose membership is no longer active is refused, so a member removed at the
 * same moment never ends up holding an active review.
 */
export async function assignReviewersTxn(params: {
  eventId: string;
  abstractId: string;
  reviewerIds: string[];
}): Promise<AssignReviewersResult> {
  const { eventId, abstractId, reviewerIds } = params;
  return withLockingTxn(async (tx): Promise<AssignReviewersResult> => {
    const activeMemberIds = await lockActiveCommitteeMemberIds(tx, eventId, reviewerIds);
    if (!(await lockAbstractForUpdate(tx, abstractId))) {
      return { ok: false, reason: "not_found" };
    }
    const [current] = await tx
      .select({ eventId: abstracts.eventId, status: abstracts.status })
      .from(abstracts)
      .where(eq(abstracts.id, abstractId))
      .limit(1);
    if (!current || current.eventId !== eventId) {
      return { ok: false, reason: "not_found" };
    }
    if (FINAL_STATUSES.includes(current.status)) {
      return { ok: false, reason: "finalized" };
    }
    const inactive = [...new Set(reviewerIds)].filter((id) => !activeMemberIds.has(id));
    if (inactive.length > 0) {
      return { ok: false, reason: "inactive_member", reviewerIds: inactive };
    }

    const inactiveDesired = reviewerIds.length
      ? await tx
          .select({ reviewerId: abstractReviews.reviewerId })
          .from(abstractReviews)
          .where(
            and(
              eq(abstractReviews.abstractId, abstractId),
              inArray(abstractReviews.reviewerId, reviewerIds),
              eq(abstractReviews.active, false),
            ),
          )
      : [];
    const needReset = new Set(inactiveDesired.map((r) => r.reviewerId));

    // Deactivate active reviews for reviewers no longer in the set.
    await tx
      .update(abstractReviews)
      .set({ active: false })
      .where(
        reviewerIds.length
          ? and(
              eq(abstractReviews.abstractId, abstractId),
              eq(abstractReviews.active, true),
              notInArray(abstractReviews.reviewerId, reviewerIds),
            )
          : and(
              eq(abstractReviews.abstractId, abstractId),
              eq(abstractReviews.active, true),
            ),
      );

    for (const reviewerId of reviewerIds) {
      const resetPrior = needReset.has(reviewerId);
      await tx
        .insert(abstractReviews)
        .values({ abstractId, eventId, reviewerId, active: true })
        .onConflictDoUpdate({
          target: [abstractReviews.abstractId, abstractReviews.reviewerId],
          set: resetPrior
            ? {
                eventId,
                active: true,
                score: null,
                comment: null,
                scoredAt: null,
              }
            : { eventId, active: true },
        });
    }

    // H8/M16: recompute averageScore/reviewCount/status from the surviving
    // active reviews instead of carrying the old status through untouched —
    // removed reviewers' scores must stop counting, and a stale
    // REVIEW_COMPLETE must not survive a newly added unscored reviewer.
    const updated = await applyReviewAggregate(tx, abstractId, reviewerIds.length > 0);
    return { ok: true, ...updated };
  });
}

// ============================================================================
// L3: reviewer assignment config needs distributeByTheme too
// ============================================================================

/**
 * Same shape as getCommitteeConfig plus distributeByTheme (L3: the flag was
 * defined on the schema but read nowhere in the assignReviewers path, so
 * assignments never enforced theme overlap even when admins turned it on).
 * Appended rather than added as a field to getCommitteeConfig to avoid
 * touching that existing export.
 */
export async function getReviewerAssignmentConfig(
  eventId: string,
): Promise<{
  reviewersPerAbstract: number;
  divergenceThreshold: number;
  distributeByTheme: boolean;
} | null> {
  const [row] = await getDb()
    .select({
      reviewersPerAbstract: abstractConfig.reviewersPerAbstract,
      divergenceThreshold: abstractConfig.divergenceThreshold,
      distributeByTheme: abstractConfig.distributeByTheme,
    })
    .from(abstractConfig)
    .where(eq(abstractConfig.eventId, eventId))
    .limit(1);
  return row ?? null;
}
