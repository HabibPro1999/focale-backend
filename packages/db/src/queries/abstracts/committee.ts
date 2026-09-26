/**
 * Committee: membership lookups, the abstracts a reviewer may see, member
 * listing and profile, membership and reviewer-theme mutations, and the
 * reviewer-facing reads.
 */
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNotNull,
  notInArray,
  or,
} from "drizzle-orm";
import { FINAL_STATUSES } from "@app/contracts";
import { getDb } from "../../client";
import { withTxn, withLockingTxn } from "../../txn";
import { lockAbstractsForUpdate } from "../../locks";
import {
  abstractCommitteeMemberships,
  abstractConfig,
  abstractReviewerThemes,
  abstractReviews,
  abstractThemeLinks,
  abstractThemes,
  abstracts,
} from "../../schema/abstracts";
import { events } from "../../schema/events-access";
import { users } from "../../schema/users-clients";
import { applyReviewAggregate } from "./review-aggregate";
import {
  loadActiveReviewRows,
  loadThemeRefs,
  type AbstractMembershipRow,
  type ReviewerAbstractRow,
} from "./shared";

// ============================================================================
// Committee — membership access helpers
// ============================================================================

export async function findAbstractMembership(
  eventId: string,
  userId: string,
): Promise<AbstractMembershipRow | null> {
  const [row] = await getDb()
    .select()
    .from(abstractCommitteeMemberships)
    .where(
      and(
        eq(abstractCommitteeMemberships.userId, userId),
        eq(abstractCommitteeMemberships.eventId, eventId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listActiveReviewerThemeIds(
  eventId: string,
  userId: string,
): Promise<string[]> {
  const rows = await getDb()
    .select({ themeId: abstractReviewerThemes.themeId })
    .from(abstractReviewerThemes)
    .where(
      and(
        eq(abstractReviewerThemes.eventId, eventId),
        eq(abstractReviewerThemes.userId, userId),
        eq(abstractReviewerThemes.active, true),
      ),
    );
  return rows.map((r) => r.themeId);
}

/**
 * Where-clause for the abstracts a reviewer may see: an active explicit review
 * row OR (when they have active theme prefs) a theme overlap. Zero prefs +
 * zero explicit reviews ⇒ nothing.
 */
function accessibleAbstractWhere(
  eventId: string,
  reviewerId: string,
  reviewerThemeIds: string[],
) {
  const orParts = [
    inArray(
      abstracts.id,
      getDb()
        .select({ id: abstractReviews.abstractId })
        .from(abstractReviews)
        .where(
          and(
            eq(abstractReviews.reviewerId, reviewerId),
            eq(abstractReviews.eventId, eventId),
            eq(abstractReviews.active, true),
          ),
        ),
    ),
  ];
  if (reviewerThemeIds.length > 0) {
    orParts.push(
      inArray(
        abstracts.id,
        getDb()
          .select({ id: abstractThemeLinks.abstractId })
          .from(abstractThemeLinks)
          .where(inArray(abstractThemeLinks.themeId, reviewerThemeIds)),
      ),
    );
  }
  return and(eq(abstracts.eventId, eventId), or(...orParts));
}

export async function countAccessibleAbstracts(
  eventId: string,
  reviewerId: string,
): Promise<number> {
  const themeIds = await listActiveReviewerThemeIds(eventId, reviewerId);
  const [row] = await getDb()
    .select({ n: count() })
    .from(abstracts)
    .where(accessibleAbstractWhere(eventId, reviewerId, themeIds));
  return row?.n ?? 0;
}

// ============================================================================
// Committee — member listing + profile
// ============================================================================

export interface CommitteeMemberDto {
  userId: string;
  email: string;
  name: string;
  active: boolean;
  themeIds: string[];
  assignedCount: number;
  scoredCount: number;
}

export async function listCommitteeMembers(
  eventId: string,
): Promise<CommitteeMemberDto[]> {
  const memberships = await getDb()
    .select({
      userId: abstractCommitteeMemberships.userId,
      active: abstractCommitteeMemberships.active,
      email: users.email,
      name: users.name,
    })
    .from(abstractCommitteeMemberships)
    .innerJoin(users, eq(abstractCommitteeMemberships.userId, users.id))
    .where(
      and(
        eq(abstractCommitteeMemberships.eventId, eventId),
        eq(abstractCommitteeMemberships.active, true),
      ),
    )
    .orderBy(asc(abstractCommitteeMemberships.createdAt));

  const userIds = memberships.map((m) => m.userId);

  const [themePrefs, scoredGroups, assignedPairs] = await Promise.all([
    userIds.length
      ? getDb()
          .select({
            userId: abstractReviewerThemes.userId,
            themeId: abstractReviewerThemes.themeId,
          })
          .from(abstractReviewerThemes)
          .where(
            and(
              eq(abstractReviewerThemes.eventId, eventId),
              inArray(abstractReviewerThemes.userId, userIds),
              eq(abstractReviewerThemes.active, true),
            ),
          )
      : Promise.resolve([]),
    userIds.length
      ? getDb()
          .select({
            reviewerId: abstractReviews.reviewerId,
            n: count(),
          })
          .from(abstractReviews)
          .where(
            and(
              eq(abstractReviews.eventId, eventId),
              inArray(abstractReviews.reviewerId, userIds),
              eq(abstractReviews.active, true),
              isNotNull(abstractReviews.scoredAt),
            ),
          )
          .groupBy(abstractReviews.reviewerId)
      : Promise.resolve([]),
    Promise.all(
      memberships.map(
        async (m) =>
          [m.userId, await countAccessibleAbstracts(eventId, m.userId)] as const,
      ),
    ),
  ]);

  const themesByUser = new Map<string, string[]>();
  for (const pref of themePrefs) {
    const current = themesByUser.get(pref.userId) ?? [];
    current.push(pref.themeId);
    themesByUser.set(pref.userId, current);
  }
  const scoredByUser = new Map(scoredGroups.map((g) => [g.reviewerId, g.n]));
  const assignedByUser = new Map(assignedPairs);

  return memberships.map((m) => ({
    userId: m.userId,
    email: m.email,
    name: m.name,
    active: m.active,
    themeIds: themesByUser.get(m.userId) ?? [],
    assignedCount: assignedByUser.get(m.userId) ?? 0,
    scoredCount: scoredByUser.get(m.userId) ?? 0,
  }));
}

export interface CommitteeProfileEvent {
  eventId: string;
  eventName: string;
  assignedCount: number;
  scoredCount: number;
}

export async function getCommitteeProfile(
  userId: string,
): Promise<{ events: CommitteeProfileEvent[] }> {
  const memberships = await getDb()
    .select({
      eventId: abstractCommitteeMemberships.eventId,
      eventName: events.name,
    })
    .from(abstractCommitteeMemberships)
    .innerJoin(events, eq(abstractCommitteeMemberships.eventId, events.id))
    .where(
      and(
        eq(abstractCommitteeMemberships.userId, userId),
        eq(abstractCommitteeMemberships.active, true),
      ),
    )
    .orderBy(asc(abstractCommitteeMemberships.createdAt));

  const eventIds = memberships.map((m) => m.eventId);

  const [assignedPairs, scoredGroups] = await Promise.all([
    Promise.all(
      memberships.map(
        async (m) =>
          [m.eventId, await countAccessibleAbstracts(m.eventId, userId)] as const,
      ),
    ),
    eventIds.length
      ? getDb()
          .select({ eventId: abstractReviews.eventId, n: count() })
          .from(abstractReviews)
          .where(
            and(
              eq(abstractReviews.reviewerId, userId),
              inArray(abstractReviews.eventId, eventIds),
              eq(abstractReviews.active, true),
              isNotNull(abstractReviews.scoredAt),
            ),
          )
          .groupBy(abstractReviews.eventId)
      : Promise.resolve([]),
  ]);

  const assignedByEvent = new Map(assignedPairs);
  const scoredByEvent = new Map(scoredGroups.map((g) => [g.eventId, g.n]));

  return {
    events: memberships.map((m) => ({
      eventId: m.eventId,
      eventName: m.eventName,
      assignedCount: assignedByEvent.get(m.eventId) ?? 0,
      scoredCount: scoredByEvent.get(m.eventId) ?? 0,
    })),
  };
}

// ============================================================================
// Committee — membership mutations
// ============================================================================

export async function upsertCommitteeMembership(
  eventId: string,
  userId: string,
): Promise<void> {
  await getDb()
    .insert(abstractCommitteeMemberships)
    .values({ userId, eventId, active: true })
    .onConflictDoUpdate({
      target: [
        abstractCommitteeMemberships.userId,
        abstractCommitteeMemberships.eventId,
      ],
      set: { active: true },
    });
}

/** Deactivate a membership + all its reviewer-theme prefs in one transaction. */
export async function deactivateCommitteeMembershipTxn(
  eventId: string,
  userId: string,
): Promise<void> {
  await withLockingTxn(async (tx) => {
    await tx
      .update(abstractCommitteeMemberships)
      .set({ active: false })
      .where(
        and(
          eq(abstractCommitteeMemberships.userId, userId),
          eq(abstractCommitteeMemberships.eventId, eventId),
        ),
      );
    await tx
      .update(abstractReviewerThemes)
      .set({ active: false })
      .where(
        and(
          eq(abstractReviewerThemes.eventId, eventId),
          eq(abstractReviewerThemes.userId, userId),
        ),
      );

    // M15: also deactivate this reviewer's active reviews on the event's
    // abstracts, then recompute averageScore/reviewCount/status for each
    // affected abstract — otherwise their score keeps counting and any
    // unscored assignment blocks REVIEW_COMPLETE forever.
    //
    // Finalized abstracts are deliberately untouched: their review rows and
    // stored aggregates are the historical inputs to an already-made decision,
    // and offboarding a member must not rewrite that record.
    //
    // The affected abstracts are locked in ascending id order (ADR 0001) and
    // their status is read after the lock, so a review, assignment or
    // finalize on one of them runs wholly before or after this recompute.
    //
    // The membership UPDATE above holds the membership row, which
    // assignReviewersTxn locks before its abstract (membership → abstracts).
    // An assignment of this member therefore either committed before that
    // UPDATE, and its review is found below, or waits and sees the
    // membership inactive.
    const candidateReviews = await tx
      .select({ abstractId: abstractReviews.abstractId })
      .from(abstractReviews)
      .where(
        and(
          eq(abstractReviews.eventId, eventId),
          eq(abstractReviews.reviewerId, userId),
          eq(abstractReviews.active, true),
        ),
      );
    const lockedIds = await lockAbstractsForUpdate(
      tx,
      candidateReviews.map((r) => r.abstractId),
    );
    if (lockedIds.length === 0) return;
    const openAbstracts = await tx
      .select({ id: abstracts.id })
      .from(abstracts)
      .where(
        and(
          inArray(abstracts.id, lockedIds),
          notInArray(abstracts.status, FINAL_STATUSES),
        ),
      )
      .orderBy(asc(abstracts.id));
    const affectedIds = openAbstracts.map((r) => r.id);
    if (affectedIds.length === 0) return;

    await tx
      .update(abstractReviews)
      .set({ active: false })
      .where(
        and(
          eq(abstractReviews.eventId, eventId),
          eq(abstractReviews.reviewerId, userId),
          eq(abstractReviews.active, true),
          inArray(abstractReviews.abstractId, affectedIds),
        ),
      );
    for (const abstractId of affectedIds) {
      await applyReviewAggregate(tx, abstractId, false);
    }
  });
}

/** Active theme ids for an event's config; null when no config row exists. */
export async function getActiveThemeIdsForEvent(
  eventId: string,
): Promise<string[] | null> {
  const [cfg] = await getDb()
    .select({ id: abstractConfig.id })
    .from(abstractConfig)
    .where(eq(abstractConfig.eventId, eventId))
    .limit(1);
  if (!cfg) return null;
  const rows = await getDb()
    .select({ id: abstractThemes.id })
    .from(abstractThemes)
    .where(
      and(eq(abstractThemes.configId, cfg.id), eq(abstractThemes.active, true)),
    );
  return rows.map((r) => r.id);
}

/** Replace a reviewer's active theme set: deactivate all, then upsert-active each. */
export async function setReviewerThemesTxn(
  eventId: string,
  userId: string,
  themeIds: string[],
): Promise<void> {
  await withTxn(async (tx) => {
    await tx
      .update(abstractReviewerThemes)
      .set({ active: false })
      .where(
        and(
          eq(abstractReviewerThemes.eventId, eventId),
          eq(abstractReviewerThemes.userId, userId),
        ),
      );
    for (const themeId of themeIds) {
      await tx
        .insert(abstractReviewerThemes)
        .values({ userId, eventId, themeId, active: true })
        .onConflictDoUpdate({
          target: [
            abstractReviewerThemes.userId,
            abstractReviewerThemes.eventId,
            abstractReviewerThemes.themeId,
          ],
          set: { active: true },
        });
    }
  });
}

/**
 * DISTINCT clientIds of every event where the user holds an ACTIVE
 * abstractCommitteeMemberships row. Committee accounts are deliberately
 * global (one reviewer can serve multiple clients' events, see C2), so the
 * set-password guard needs the caller's full cross-tenant membership footprint.
 */
export async function findCommitteeUserClientIds(userId: string): Promise<string[]> {
  const rows = await getDb()
    .selectDistinct({ clientId: events.clientId })
    .from(abstractCommitteeMemberships)
    .innerJoin(events, eq(abstractCommitteeMemberships.eventId, events.id))
    .where(
      and(
        eq(abstractCommitteeMemberships.userId, userId),
        eq(abstractCommitteeMemberships.active, true),
      ),
    );
  return rows.map((r) => r.clientId);
}

export interface CommitteeInviteTarget {
  active: boolean;
  userEmail: string;
  userName: string;
  eventName: string;
}

export async function findCommitteeInviteTarget(
  eventId: string,
  userId: string,
): Promise<CommitteeInviteTarget | null> {
  const [row] = await getDb()
    .select({
      active: abstractCommitteeMemberships.active,
      userEmail: users.email,
      userName: users.name,
      eventName: events.name,
    })
    .from(abstractCommitteeMemberships)
    .innerJoin(users, eq(abstractCommitteeMemberships.userId, users.id))
    .innerJoin(events, eq(abstractCommitteeMemberships.eventId, events.id))
    .where(
      and(
        eq(abstractCommitteeMemberships.userId, userId),
        eq(abstractCommitteeMemberships.eventId, eventId),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ============================================================================
// Committee — reviewer reads (anonymized in the service layer)
// ============================================================================

export async function listAssignedAbstracts(
  eventId: string,
  reviewerId: string,
): Promise<ReviewerAbstractRow[]> {
  const themeIds = await listActiveReviewerThemeIds(eventId, reviewerId);
  const rows = await getDb()
    .select()
    .from(abstracts)
    .where(accessibleAbstractWhere(eventId, reviewerId, themeIds))
    .orderBy(asc(abstracts.createdAt));
  const ids = rows.map((r) => r.id);
  const [themeMap, reviewMap] = await Promise.all([
    loadThemeRefs(ids),
    loadActiveReviewRows(ids),
  ]);
  return rows.map((r) => ({
    ...r,
    themes: themeMap.get(r.id) ?? [],
    reviews: reviewMap.get(r.id) ?? [],
  }));
}

export async function getAssignedAbstractRow(
  abstractId: string,
): Promise<ReviewerAbstractRow | null> {
  const [abstract] = await getDb()
    .select()
    .from(abstracts)
    .where(eq(abstracts.id, abstractId))
    .limit(1);
  if (!abstract) return null;
  const [themeMap, reviewMap] = await Promise.all([
    loadThemeRefs([abstractId]),
    loadActiveReviewRows([abstractId]),
  ]);
  return {
    ...abstract,
    themes: themeMap.get(abstractId) ?? [],
    reviews: reviewMap.get(abstractId) ?? [],
  };
}
