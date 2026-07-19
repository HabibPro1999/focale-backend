import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
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
  findAbstractEmailTemplate,
  createEmailLog,
  updateEmailLogById,
  type ReviewerAbstractRow,
  type AbstractReviewRow,
  type EmailTemplateRow,
} from "@app/db";
import {
  generatePasswordResetLink,
  updateFirebaseUserPassword,
  revokeFirebaseRefreshTokens,
  getEmailProvider,
  compileMjmlToHtml,
  resolveVariables,
} from "@app/integrations";
import { escapeHtml } from "@app/shared";
import { assertClientModuleEnabled } from "../clients/module-gates";
import { UsersService } from "../identity/users.service";
import { CONFIG, type Config } from "../../core/config";
import { logger } from "../../core/logger.service";
import { AppException } from "../../core/app-exception";
import { canAccessClient, type AuthUser } from "../../core/auth/user-cache";

type UserRow = NonNullable<Awaited<ReturnType<typeof getUserById>>>;

function getTitle(content: unknown): string {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const title = (content as { title?: unknown }).title;
    if (typeof title === "string") return title;
  }
  return "Untitled abstract";
}

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
    title: getTitle(abstract.content),
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
  // overwrites it via the reset link in the invite email.
  return `${randomUUID()}A!${randomUUID()}`;
}

const EVENT_NAME_TOKEN = "{eventName}";

@Injectable()
export class AbstractsCommitteeService {
  constructor(
    private readonly users: UsersService,
    @Inject(CONFIG) private readonly config: Config,
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
      { userId: user.id, eventId },
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
    ctx: { userId: string; eventId: string },
  ): Promise<boolean> {
    try {
      const link = await generatePasswordResetLink(
        email,
        this.buildPasswordResetActionCodeSettings(),
      );

      // M7: ABSTRACT_COMMITTEE_INVITE was a configurable trigger nobody ever
      // consulted — consult it before falling back to the hardcoded French
      // MJML below. Event-specific → client-wide cascade, same as every
      // other abstract email trigger.
      const event = await findEventClientId(ctx.eventId);
      const template = event
        ? await findAbstractEmailTemplate({
            clientId: event.clientId,
            eventId: ctx.eventId,
            abstractTrigger: "ABSTRACT_COMMITTEE_INVITE",
          })
        : null;
      if (template) {
        return await this.sendTemplatedCommitteeEmail(template, email, name, {
          reviewerName: name,
          eventName,
          loginLink: link,
        });
      }

      return await this.sendCommitteeMjmlEmail({
        to: email,
        toName: name,
        subject: `Invitation au comité scientifique - ${eventName}`,
        headline: "Bienvenue au comité scientifique",
        intro:
          "Vous êtes invité(e) à rejoindre le comité scientifique de {eventName} sur Focale. Pour activer votre compte, choisissez un mot de passe avec le lien sécurisé ci-dessous :",
        ctaText: "Définir mon mot de passe",
        link,
        eventName,
        category: "committee-invite",
        footnote:
          "Si vous n'attendiez pas cette invitation, vous pouvez ignorer cet email.",
        logContext: "Failed to send committee invitation email",
        logAsInvite: true,
      });
    } catch (err) {
      logger.error(
        { err, ...ctx },
        "Committee invite email threw while sending",
      );
      return false;
    }
  }

  /**
   * M7: render a configured ABSTRACT_COMMITTEE_INVITE template and send it
   * through the same provider call as the hardcoded fallback. Exposed
   * variables mirror what the hardcoded MJML used: reviewerName, eventName,
   * loginLink (the Firebase password-reset/continue link — the invite never
   * had a plaintext temporary password to expose).
   *
   * Sent synchronously (not via queueEmail/the outbox) so addCommitteeMember
   * can still report inviteEmailSent immediately, matching the fallback
   * path's contract — queueEmail defers the actual send to the worker and
   * requires an abstractId, neither of which fits this abstract-less,
   * synchronous invite flow. sendAndLogInviteEmail still records the send in
   * email_logs so it shows up in the admin's per-event log table.
   */
  private async sendTemplatedCommitteeEmail(
    template: EmailTemplateRow,
    to: string,
    toName: string,
    variables: Record<string, string>,
  ): Promise<boolean> {
    const subject = resolveVariables(template.subject, variables);
    const html = resolveVariables(template.htmlContent ?? "", variables);
    return this.sendAndLogInviteEmail({
      to,
      toName,
      subject,
      html,
      categories: ["committee-invite"],
      logContext: "Failed to send templated committee invite email",
    });
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
      currentStatus: abstract.status,
    });

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

    return reviewAbstractTxn({
      abstractId,
      eventId: abstract.eventId,
      reviewerId,
      clientId: abstract.clientId,
      score: body.score,
      comment: body.comment,
      commentsEnabled: abstract.config?.commentsEnabled ?? true,
      divergenceThreshold: abstract.config?.divergenceThreshold ?? 6,
    });
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
      const link = await generatePasswordResetLink(
        member.userEmail,
        this.buildPasswordResetActionCodeSettings(),
      );
      inviteEmailSent = await this.sendCommitteeMjmlEmail({
        to: member.userEmail,
        toName: member.userName,
        subject: "Réinitialisation du mot de passe comité",
        headline: "Réinitialiser votre mot de passe comité",
        intro:
          "Une réinitialisation du mot de passe a été demandée pour votre compte comité scientifique sur {eventName}. Utilisez le lien sécurisé ci-dessous pour choisir un nouveau mot de passe :",
        ctaText: "Définir mon mot de passe",
        link,
        eventName: member.eventName,
        category: "committee-password-reset",
        footnote:
          "Si vous n'avez pas demandé cette réinitialisation, vous pouvez ignorer cet email.",
        logContext: "Failed to send committee password-reset email",
      });
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
      changes: { method: { old: null, new: "email_link" } },
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

  // ==========================================================================
  // Email plumbing (best-effort, synchronous). Only the ABSTRACT_COMMITTEE_INVITE
  // path (logAsInvite) writes an email_logs row — resendCommitteeInvite /
  // setCommitteeMemberPassword are password resets, not that trigger, and
  // stay row-less as before.
  // ==========================================================================
  /**
   * The `url` here is the Firebase `continueUrl` (final post-reset destination),
   * NOT the action-handler URL — pointing it back at /auth/action loops onto a
   * handler page with no oobCode ("unknown mode" error).
   */
  private buildPasswordResetActionCodeSettings(): { url: string } {
    return { url: `${this.config.urls.adminAppUrl}/committee` };
  }

  /**
   * M7: create a SENDING email_logs row (trigger ABSTRACT_COMMITTEE_INVITE,
   * no registrationId/abstractId — the invite predates both) BEFORE calling
   * the provider, exactly like EmailSendService.sendCustom, so the row id can
   * serve as the provider trackingId and a webhook arriving mid-send has
   * something to correlate against. Updated to SENT/FAILED afterward,
   * including when the provider call itself throws (rather than merely
   * returning success:false). Log writes are themselves best-effort: a DB
   * hiccup here logs and is swallowed, it never turns a real send outcome
   * into a thrown error for the caller.
   */
  private async sendAndLogInviteEmail(input: {
    to: string;
    toName?: string | null;
    subject: string;
    html: string;
    categories: string[];
    logContext: string;
  }): Promise<boolean> {
    let emailLogId: string | null = null;
    try {
      const logResult = await createEmailLog({
        trigger: null,
        abstractTrigger: "ABSTRACT_COMMITTEE_INVITE",
        templateId: null,
        registrationId: null,
        abstractId: null,
        recipientEmail: input.to,
        recipientName: input.toName || null,
        subject: input.subject,
        status: "SENDING",
      });
      if (logResult.ok) emailLogId = logResult.log.id;
    } catch (err) {
      logger.error(
        { err, email: input.to },
        "Failed to create committee invite email log",
      );
    }

    let result: { success: boolean; messageId?: string; error?: string };
    try {
      result = await getEmailProvider().sendEmail({
        to: input.to,
        toName: input.toName ?? undefined,
        subject: input.subject,
        html: input.html,
        categories: input.categories,
        trackingId: emailLogId ?? undefined,
      });
    } catch (err) {
      result = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (emailLogId) {
      try {
        await updateEmailLogById(
          emailLogId,
          result.success
            ? {
                status: "SENT",
                providerMessageId: result.messageId,
                sentAt: new Date(),
              }
            : {
                status: "FAILED",
                errorMessage: result.error || "Unknown error",
                failedAt: new Date(),
              },
        );
      } catch (err) {
        logger.error(
          { err, emailLogId },
          "Failed to update committee invite email log",
        );
      }
    }

    if (!result.success) {
      logger.error({ email: input.to, error: result.error }, input.logContext);
    }
    return result.success;
  }

  private async sendCommitteeMjmlEmail(input: {
    to: string;
    toName?: string | null;
    subject: string;
    headline: string;
    intro: string;
    ctaText: string;
    link: string;
    eventName: string;
    category: string;
    footnote?: string;
    logContext: string;
    /** M7: only the ABSTRACT_COMMITTEE_INVITE fallback records an email_logs row. */
    logAsInvite?: boolean;
  }): Promise<boolean> {
    const toName = input.toName?.trim() || input.to;
    const safeName = escapeHtml(toName);
    const safeEventName = escapeHtml(input.eventName);
    const safeLink = escapeHtml(input.link);
    const safeHeadline = escapeHtml(input.headline);
    const safeCtaText = escapeHtml(input.ctaText);
    const safeIntro = escapeHtml(input.intro).replaceAll(
      EVENT_NAME_TOKEN,
      `<strong>${safeEventName}</strong>`,
    );
    const footnoteBlock = input.footnote
      ? `<mj-text font-size="13px" color="#6b7280">${escapeHtml(
          input.footnote,
        )}</mj-text>`
      : "";
    const mjml = `
<mjml>
  <mj-head>
    <mj-attributes>
      <mj-all font-family="Helvetica, Arial, sans-serif" />
      <mj-text font-size="15px" line-height="1.6" color="#1f2937" />
    </mj-attributes>
  </mj-head>
  <mj-body background-color="#fafaf9">
    <mj-section padding="32px 24px">
      <mj-column>
        <mj-text font-size="20px" font-weight="600">${safeHeadline}</mj-text>
        <mj-text>Bonjour ${safeName},</mj-text>
        <mj-text>${safeIntro}</mj-text>
        <mj-button background-color="#0d9488" color="#ffffff" border-radius="6px" href="${safeLink}">${safeCtaText}</mj-button>
        <mj-text font-size="13px" color="#6b7280">Ce lien est valable pour une durée limitée. Après avoir défini votre mot de passe, vous pourrez vous connecter directement avec votre email.</mj-text>
        ${footnoteBlock}
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;
    const { html } = compileMjmlToHtml(mjml);

    if (input.logAsInvite) {
      return this.sendAndLogInviteEmail({
        to: input.to,
        toName,
        subject: input.subject,
        html,
        categories: [input.category],
        logContext: input.logContext,
      });
    }

    const result = await getEmailProvider().sendEmail({
      to: input.to,
      toName,
      subject: input.subject,
      html,
      categories: [input.category],
    });
    if (!result.success) {
      logger.error({ email: input.to, error: result.error }, input.logContext);
    }
    return result.success;
  }
}
