import { CommitteeInviteService } from "./abstracts.committee-invite.service";
import { CommitteeEmailsService } from "./abstracts.committee-emails";
import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { getAbstractTitle } from "@app/shared";
import {
  ErrorCodes,
  UserRole,
  FINAL_STATUSES,
  type AddCommitteeMemberInput,
  type AssignReviewersInput,
  type ReviewAbstractInput,
  type SetReviewerThemesInput,
} from "@app/contracts";
import {
  findAbstractMembership,
  deleteUnusedCommitteeInvites,
  findEventClientId,
  findEventName,
  listActiveReviewerThemeIds,
  listCommitteeMembers,
  getCommitteeProfile,
  upsertCommitteeMembership,
  deactivateCommitteeMembershipTxn,
  getActiveThemeIdsForEvent,
  setReviewerThemesTxn,
  findCommitteeInviteTarget,
  findAbstractBasic,
  findAbstractThemeIds,
  getReviewerAssignmentConfig,
  findScoredReviewScores,
  findActiveMembershipUserIds,
  assignReviewersTxn,
  listAssignedAbstracts,
  getAssignedAbstractRow,
  findAbstractForReview,
  reviewAbstractTxn,
  insertAuditLog,
  getUserByEmail,
  getUserById,
  findCommitteeUserClientIds,
  type ReviewerAbstractRow,
  type AbstractReviewRow,
} from "@app/db";
import {
  updateFirebaseUserPassword,
  revokeFirebaseRefreshTokens,
} from "@app/integrations";
import { assertClientModuleEnabled } from "../clients/module-gates";
import { UsersService } from "../identity/users.service";
import { logger } from "../../core/logger.service";
import { AppException } from "../../core/app-exception";
import { canAccessClient, type AuthUser } from "../../core/auth/user-cache";

type UserRow = NonNullable<Awaited<ReturnType<typeof getUserById>>>;

function ownReviewOf(reviews: AbstractReviewRow[], reviewerId: string) {
  const own = reviews.find((r) => r.reviewerId === reviewerId);
  return own
    ? { score: own.score, comment: own.comment, scoredAt: own.scoredAt }
    : null;
}

/** List DTO: NO author PII, averageScore ALWAYS null (reviewers see only their own). */
function anonymizeAbstractListItem(
  abstract: ReviewerAbstractRow,
  reviewerId: string,
) {
  return {
    id: abstract.id,
    status: abstract.status,
    title: getAbstractTitle(abstract.content),
    requestedType: abstract.requestedType,
    finalType: abstract.finalType,
    themeLabels: abstract.themes.map((t) => t.label),
    averageScore: null,
    reviewCount: abstract.reviewCount,
    ownReview: ownReviewOf(abstract.reviews, reviewerId),
  };
}

function anonymizeAbstractDetail(
  abstract: ReviewerAbstractRow,
  reviewerId: string,
) {
  return {
    id: abstract.id,
    eventId: abstract.eventId,
    status: abstract.status,
    requestedType: abstract.requestedType,
    finalType: abstract.finalType,
    content: abstract.content,
    contentVersion: abstract.contentVersion,
    themeLabels: abstract.themes.map((t) => t.label),
    averageScore: null,
    reviewCount: abstract.reviewCount,
    createdAt: abstract.createdAt,
    updatedAt: abstract.updatedAt,
    lastEditedAt: abstract.lastEditedAt,
    ownReview: ownReviewOf(abstract.reviews, reviewerId),
  };
}

function hasReviewerThemeCoverage(
  themes: { id: string }[],
  reviewerThemeIds: string[],
): boolean {
  if (reviewerThemeIds.length === 0) return false;
  const covered = new Set(reviewerThemeIds);
  return themes.some((t) => covered.has(t.id));
}

function generateThrowawayPassword(): string {
  // Throwaway to satisfy Firebase's password policy — the user immediately
  // overwrites it via the single-use link in the invite email.
  return `${randomUUID()}A!${randomUUID()}`;
}

function finalizedReviewersError(): AppException {
  return new AppException(
    ErrorCodes.INVALID_STATUS_TRANSITION,
    "Reviewers of a finalized abstract cannot change; reopen it first",
    409,
  );
}

@Injectable()
export class AbstractsCommitteeService {
  constructor(
    private readonly users: UsersService,
    private readonly invites: CommitteeInviteService,
    private readonly emails: CommitteeEmailsService,
  ) {}

  // ==========================================================================
  // Membership guards
  // ==========================================================================
  private async assertActiveMembership(
    eventId: string,
    userId: string,
  ): Promise<void> {
    const membership = await findAbstractMembership(eventId, userId);
    if (!membership?.active) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        "Active committee membership required",
        403,
      );
    }
    const event = await findEventClientId(eventId);
    if (!event) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }
    await assertClientModuleEnabled(event.clientId, "abstracts");
  }

  /** Stricter cousin for admin password ops: 404 (not 403) when not an active member. */
  private async assertCommitteeMemberExists(
    eventId: string,
    userId: string,
  ): Promise<void> {
    const membership = await findAbstractMembership(eventId, userId);
    if (!membership?.active) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Committee member not found",
        404,
      );
    }
  }

  // ==========================================================================
  // Committee member listing
  // ==========================================================================
  listCommitteeMembers(eventId: string) {
    return listCommitteeMembers(eventId);
  }

  // ==========================================================================
  // Add committee member (reuse-by-email / create-by-email / by-userId)
  // ==========================================================================
  private assertCommitteeUserEligible(user: UserRow): void {
    if (
      user.role === UserRole.SUPER_ADMIN ||
      user.role === UserRole.CLIENT_ADMIN
    ) {
      throw new AppException(
        ErrorCodes.VALIDATION_ERROR,
        "This email belongs to an admin account. Admin accounts cannot be added as scientific committee members.",
        400,
      );
    }
    if (user.role !== UserRole.SCIENTIFIC_COMMITTEE) {
      throw new AppException(
        ErrorCodes.VALIDATION_ERROR,
        "This email does not belong to a scientific committee account.",
        400,
      );
    }
    if (!user.active) {
      throw new AppException(
        ErrorCodes.VALIDATION_ERROR,
        "This email belongs to an inactive scientific committee account. Reactivate the account before adding it to an event.",
        400,
      );
    }
    if (user.clientId !== null) {
      throw new AppException(
        ErrorCodes.VALIDATION_ERROR,
        "This email belongs to a client-scoped account. Only unscoped scientific committee accounts can be added as committee members.",
        400,
      );
    }
  }

  async addCommitteeMember(
    eventId: string,
    body: AddCommitteeMemberInput,
    performedBy: string,
  ) {
    let existingUserAdded = false;
    let user: UserRow | undefined;

    if ("userId" in body) {
      user = await getUserById(body.userId);
    } else {
      const existing = await getUserByEmail(body.email);
      if (existing) {
        user = existing;
        existingUserAdded = true;
      } else {
        user = await this.users.createUser({
          email: body.email,
          name: body.name,
          password: generateThrowawayPassword(),
          role: UserRole.SCIENTIFIC_COMMITTEE,
          clientId: null,
        });
      }
    }

    if (!user) {
      throw new AppException(ErrorCodes.NOT_FOUND, "User not found", 404);
    }
    this.assertCommitteeUserEligible(user);

    await upsertCommitteeMembership(eventId, user.id);
    await insertAuditLog({
      entityType: "AbstractCommitteeMembership",
      entityId: `${eventId}:${user.id}`,
      action: "upsert",
      changes: { active: { old: null, new: true } },
      performedBy,
    });

    const eventName = (await findEventName(eventId)) ?? "the event";
    // Best-effort: invite delivery failure is reported, never rolls back membership.
    const inviteEmailSent = await this.sendInviteBestEffort(
      user.email,
      user.name,
      eventName,
      { userId: user.id, eventId, performedBy },
    );

    const member = (await listCommitteeMembers(eventId)).find(
      (m) => m.userId === user!.id,
    ) ?? {
      userId: user.id,
      email: user.email,
      name: user.name,
      active: true,
      themeIds: [] as string[],
      assignedCount: 0,
      scoredCount: 0,
    };

    return {
      ...member,
      inviteEmailSent,
      ...(existingUserAdded ? { existingUserAdded } : {}),
    };
  }

  private async sendInviteBestEffort(
    email: string,
    name: string,
    eventName: string,
    ctx: { userId: string; eventId: string; performedBy: string },
  ): Promise<boolean> {
    try {
      const token = await this.invites.mintCommitteeInviteToken(
        ctx.userId,
        ctx.eventId,
        ctx.performedBy,
      );
      return await this.emails.sendInviteEmail(
        { email, name },
        eventName,
        this.invites.buildCommitteeInviteLink(token),
        ctx.eventId,
      );
    } catch (err) {
      logger.error({ err, ...ctx }, "Committee invite email threw while sending");
      return false;
    }
  }

  // ==========================================================================
  // Remove committee member
  // ==========================================================================
  async removeCommitteeMember(
    eventId: string,
    userId: string,
    performedBy: string,
  ): Promise<void> {
    await this.assertActiveMembership(eventId, userId);
    await deactivateCommitteeMembershipTxn(eventId, userId);
    await insertAuditLog({
      entityType: "AbstractCommitteeMembership",
      entityId: `${eventId}:${userId}`,
      action: "deactivate",
      changes: { active: { old: true, new: false } },
      performedBy,
    });
  }

  // ==========================================================================
  // Set reviewer themes (replace active set)
  // ==========================================================================
  async setReviewerThemes(
    eventId: string,
    userId: string,
    body: SetReviewerThemesInput,
    performedBy: string,
  ) {
    await this.assertActiveMembership(eventId, userId);
    const uniqueThemeIds = [...new Set(body.themeIds)];
    const activeThemeIds = await getActiveThemeIdsForEvent(eventId);
    if (activeThemeIds === null) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Abstract config not found",
        404,
      );
    }
    const activeSet = new Set(activeThemeIds);
    if (uniqueThemeIds.some((id) => !activeSet.has(id))) {
      throw new AppException(
        ErrorCodes.ABSTRACT_INVALID_THEMES,
        "Invalid abstract themes",
        400,
      );
    }

    await setReviewerThemesTxn(eventId, userId, uniqueThemeIds);
    await insertAuditLog({
      entityType: "AbstractReviewerTheme",
      entityId: `${eventId}:${userId}`,
      action: "replace",
      changes: { themeIds: { old: null, new: uniqueThemeIds } },
      performedBy,
    });

    const member = (await listCommitteeMembers(eventId)).find(
      (m) => m.userId === userId,
    );
    if (!member) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Committee member not found",
        404,
      );
    }
    return member;
  }

  // ==========================================================================
  // Assign reviewers
  // ==========================================================================
  async assignReviewers(
    eventId: string,
    abstractId: string,
    body: AssignReviewersInput,
    performedBy: string,
  ) {
    const abstract = await findAbstractBasic(abstractId);
    if (!abstract || abstract.eventId !== eventId) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Abstract not found", 404);
    }
    if (FINAL_STATUSES.includes(abstract.status)) {
      throw finalizedReviewersError();
    }
    const reviewerIds = [...new Set(body.reviewerIds)];
    const config = await getReviewerAssignmentConfig(eventId);
    const requiredReviewers = config?.reviewersPerAbstract ?? 2;

    if (reviewerIds.length > 0) {
      if (reviewerIds.length < requiredReviewers) {
        throw new AppException(
          ErrorCodes.VALIDATION_ERROR,
          `Exactly ${requiredReviewers} reviewers are required for initial assignment`,
          400,
        );
      }
      if (reviewerIds.length > requiredReviewers) {
        const scores = await findScoredReviewScores(abstractId);
        const min = scores.length >= 2 ? Math.min(...scores) : null;
        const max = scores.length >= 2 ? Math.max(...scores) : null;
        const spread = min !== null && max !== null ? max - min : 0;
        if (spread < (config?.divergenceThreshold ?? 6)) {
          throw new AppException(
            ErrorCodes.VALIDATION_ERROR,
            "Extra reviewers can only be assigned after a score divergence alert",
            400,
          );
        }
      }
      const activeMemberIds = new Set(
        await findActiveMembershipUserIds(eventId, reviewerIds),
      );
      if (reviewerIds.some((id) => !activeMemberIds.has(id))) {
        throw new AppException(
          ErrorCodes.VALIDATION_ERROR,
          "All reviewers must have active membership",
          400,
        );
      }

      // L3: distributeByTheme wires up an until-now-dead config flag — when
      // on, every assigned reviewer must share at least one theme with the
      // abstract. Off (default) keeps the prior permissive behavior.
      if (config?.distributeByTheme) {
        const abstractThemeIds = new Set(await findAbstractThemeIds(abstractId));
        const offending: string[] = [];
        for (const reviewerId of reviewerIds) {
          const reviewerThemeIds = await listActiveReviewerThemeIds(
            eventId,
            reviewerId,
          );
          if (!reviewerThemeIds.some((id) => abstractThemeIds.has(id))) {
            offending.push(reviewerId);
          }
        }
        if (offending.length > 0) {
          throw new AppException(
            ErrorCodes.VALIDATION_ERROR,
            `Reviewers have no theme overlap with this abstract: ${offending.join(", ")}`,
            422,
            { reviewerIds: offending },
          );
        }
      }
    }

    const updated = await assignReviewersTxn({
      eventId,
      abstractId,
      reviewerIds,
    });
    if (!updated.ok) {
      if (updated.reason === "not_found") {
        throw new AppException(ErrorCodes.NOT_FOUND, "Abstract not found", 404);
      }
      throw finalizedReviewersError();
    }

    await insertAuditLog({
      entityType: "Abstract",
      entityId: abstractId,
      action: "assign_reviewers",
      changes: { reviewerIds: { old: null, new: reviewerIds } },
      performedBy,
    });

    return { abstractId: updated.id, status: updated.status, reviewerIds };
  }

  // ==========================================================================
  // Committee self-service (reviewer-facing)
  // ==========================================================================
  getCommitteeProfile(userId: string) {
    return getCommitteeProfile(userId);
  }

  async listAssignedAbstracts(eventId: string, reviewerId: string) {
    await this.assertActiveMembership(eventId, reviewerId);
    const abstracts = await listAssignedAbstracts(eventId, reviewerId);
    return abstracts.map((a) => anonymizeAbstractListItem(a, reviewerId));
  }

  async getAssignedAbstractDetail(abstractId: string, reviewerId: string) {
    const abstract = await getAssignedAbstractRow(abstractId);
    if (!abstract) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Abstract not found", 404);
    }
    await this.assertActiveMembership(abstract.eventId, reviewerId);
    const reviewerThemeIds = await listActiveReviewerThemeIds(
      abstract.eventId,
      reviewerId,
    );
    const hasExplicit = abstract.reviews.some(
      (r) => r.reviewerId === reviewerId && r.active,
    );
    if (
      !hasExplicit &&
      !hasReviewerThemeCoverage(abstract.themes, reviewerThemeIds)
    ) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Abstract assignment not found",
        404,
      );
    }
    return anonymizeAbstractDetail(abstract, reviewerId);
  }

  async reviewAssignedAbstract(
    abstractId: string,
    reviewerId: string,
    body: ReviewAbstractInput,
  ) {
    const abstract = await findAbstractForReview(abstractId);
    if (!abstract) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Abstract not found", 404);
    }
    await this.assertActiveMembership(abstract.eventId, reviewerId);

    if (FINAL_STATUSES.includes(abstract.status)) {
      throw new AppException(
        ErrorCodes.INVALID_STATUS_TRANSITION,
        "Abstract is not open for scoring",
        409,
      );
    }
    const now = Date.now();
    const startAt = abstract.config?.scoringStartAt;
    const deadline = abstract.config?.scoringDeadline;
    if (startAt && startAt.getTime() > now) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        "Scoring has not started yet",
        403,
      );
    }
    if (deadline && deadline.getTime() < now) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        "Scoring deadline has passed",
        403,
      );
    }
    // H10: comments-disabled no longer rejects the whole submission (score
    // included) — reviewAbstractTxn already null-coalesces the comment away
    // when commentsEnabled is false, so the score still saves.
    //
    // H4: scoring requires an ACTIVE explicit review row, full stop. Theme
    // coverage (hasReviewerThemeCoverage) only ever grants read/view access
    // (see getAssignedAbstractDetail) — it must never grant scoring, or a
    // removed reviewer (active:false, membership/theme prefs left intact)
    // could self-reinstate via the upsert in reviewAbstractTxn and defeat the
    // exactly-N-reviewers / divergence-gated-extras rules.
    const hasExplicit = abstract.reviews.some(
      (r) => r.reviewerId === reviewerId && r.active,
    );
    if (!hasExplicit) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        "You are not an active assigned reviewer for this abstract",
        403,
      );
    }

    // The checks above ran before the transaction; it re-checks the status and
    // the active assignment under the abstract's row lock.
    const result = await reviewAbstractTxn({
      abstractId,
      eventId: abstract.eventId,
      reviewerId,
      clientId: abstract.clientId,
      score: body.score,
      comment: body.comment,
      commentsEnabled: abstract.config?.commentsEnabled ?? true,
      divergenceThreshold: abstract.config?.divergenceThreshold ?? 6,
    });
    if (!result.ok) {
      switch (result.reason) {
        case "not_found":
          throw new AppException(ErrorCodes.NOT_FOUND, "Abstract not found", 404);
        case "finalized":
          throw new AppException(
            ErrorCodes.INVALID_STATUS_TRANSITION,
            "Abstract is not open for scoring",
            409,
          );
        case "not_assigned":
          throw new AppException(
            ErrorCodes.FORBIDDEN,
            "You are not an active assigned reviewer for this abstract",
            403,
          );
      }
    }
    const { id, status, averageScore, reviewCount } = result;
    return { id, status, averageScore, reviewCount };
  }

  // ==========================================================================
  // Admin password ops
  // ==========================================================================
  async resendCommitteeInvite(
    eventId: string,
    userId: string,
    performedBy: string,
  ) {
    const member = await findCommitteeInviteTarget(eventId, userId);
    if (!member?.active) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Committee member not found",
        404,
      );
    }

    let inviteEmailSent = false;
    try {
      const token = await this.invites.mintCommitteeInviteToken(userId, eventId, performedBy);
      inviteEmailSent = await this.emails.sendResetPasswordEmail(
        { email: member.userEmail, name: member.userName }, member.eventName,
        this.invites.buildCommitteeInviteLink(token));
    } catch (err) {
      logger.error(
        { err, userId, eventId },
        "Committee reset-password email threw while sending",
      );
      inviteEmailSent = false;
    }

    // Audit the admin's intent regardless of delivery outcome.
    await insertAuditLog({
      entityType: "User",
      entityId: userId,
      action: "admin_reset_password",
      changes: { method: { old: null, new: "invite_token" } },
      performedBy,
    });

    return { inviteEmailSent };
  }

  async setCommitteeMemberPassword(
    eventId: string,
    userId: string,
    newPassword: string,
    caller: Pick<AuthUser, "id" | "role" | "clientId">,
  ) {
    await this.assertCommitteeMemberExists(eventId, userId);

    // C2: committee accounts are deliberately cross-tenant (a reviewer can
    // belong to many clients' events — assertCommitteeUserEligible enforces
    // clientId===null on the account itself), so resetting the account's
    // password grants the caller a login that also reaches every OTHER
    // client this user reviews for. Forbid unless the caller's own access
    // (super-admin, or client-admin whose single client matches) already
    // covers every client the target holds an active membership under.
    const targetClientIds = await findCommitteeUserClientIds(userId);
    const inaccessibleClientIds = targetClientIds.filter(
      (clientId) => !canAccessClient(caller, clientId),
    );
    if (inaccessibleClientIds.length > 0) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        "This committee member is shared with other clients your account cannot access",
        403,
      );
    }

    await updateFirebaseUserPassword(userId, newPassword);
    await revokeFirebaseRefreshTokens(userId);
    try { await deleteUnusedCommitteeInvites(userId); }
    catch (err) { logger.error({ err, userId, eventId }, "Failed to purge committee invite tokens after an admin password override"); }
    await insertAuditLog({
      entityType: "User",
      entityId: userId,
      action: "admin_reset_password",
      // The plaintext password never enters the audit log.
      changes: { method: { old: null, new: "direct" } },
      performedBy: caller.id,
    });
    return { ok: true as const };
  }

}
