import { randomUUID } from "node:crypto";
import { prisma } from "@/database/client.js";
import {
  AbstractStatus,
  Prisma,
  type Abstract,
  type AbstractReview,
  type AbstractTheme,
  type User,
} from "@/generated/prisma/client.js";
import { createUser } from "@modules/identity/users.service.js";
import { UserRole } from "@shared/constants/roles.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { auditLog } from "@shared/utils/audit.js";
import { logger } from "@shared/utils/logger.js";
import type { TxClient } from "@shared/types/prisma.js";
import {
  enqueueAbstractEmailOutboxEvent,
  enqueueRealtimeOutboxEvent,
} from "@core/outbox";
import {
  generatePasswordResetLink,
  revokeFirebaseRefreshTokens,
  updateFirebaseUserPassword,
} from "@shared/services/firebase.service.js";
import { sendEmail } from "@modules/email/email-sendgrid.service.js";
import {
  compileMjmlToHtml,
  escapeHtml,
} from "@modules/email/email-renderer.service.js";
import { config } from "@config/app.config.js";
import type { ActionCodeSettings } from "firebase-admin/auth";
import type {
  AddCommitteeMemberInput,
  AssignReviewersInput,
  ReviewAbstractInput,
  SetReviewerThemesInput,
} from "./abstracts.schema.js";
import { FINAL_STATUSES } from "./abstracts.constants.js";

type AbstractContent = Record<string, unknown>;
const ONE_HOUR_MS = 60 * 60 * 1000;

type ThemeLink = { theme: Pick<AbstractTheme, "id" | "label"> };

function getTitle(content: Prisma.JsonValue): string {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const title = (content as AbstractContent).title;
    if (typeof title === "string") return title;
  }
  return "Untitled abstract";
}

function anonymizeAbstractListItem(
  abstract: Abstract & {
    themes: ThemeLink[];
    reviews: AbstractReview[];
  },
  reviewerId: string,
) {
  const ownReview = abstract.reviews.find((r) => r.reviewerId === reviewerId);
  return {
    id: abstract.id,
    status: abstract.status,
    title: getTitle(abstract.content),
    requestedType: abstract.requestedType,
    finalType: abstract.finalType,
    themeLabels: abstract.themes.map((link) => link.theme.label),
    averageScore: abstract.averageScore,
    reviewCount: abstract.reviewCount,
    ownReview: ownReview
      ? {
          score: ownReview.score,
          comment: ownReview.comment,
          scoredAt: ownReview.scoredAt,
        }
      : null,
  };
}

function anonymizeAbstractDetail(
  abstract: Abstract & {
    themes: ThemeLink[];
    reviews: AbstractReview[];
  },
  reviewerId: string,
) {
  const ownReview = abstract.reviews.find((r) => r.reviewerId === reviewerId);
  return {
    id: abstract.id,
    eventId: abstract.eventId,
    status: abstract.status,
    requestedType: abstract.requestedType,
    finalType: abstract.finalType,
    content: abstract.content,
    contentVersion: abstract.contentVersion,
    themeLabels: abstract.themes.map((link) => link.theme.label),
    averageScore: abstract.averageScore,
    reviewCount: abstract.reviewCount,
    createdAt: abstract.createdAt,
    updatedAt: abstract.updatedAt,
    lastEditedAt: abstract.lastEditedAt,
    ownReview: ownReview
      ? {
          score: ownReview.score,
          comment: ownReview.comment,
          scoredAt: ownReview.scoredAt,
        }
      : null,
  };
}

async function findCommitteeMembership(eventId: string, userId: string) {
  return prisma.abstractCommitteeMembership.findUnique({
    where: { userId_eventId: { userId, eventId } },
  });
}

async function assertActiveMembership(eventId: string, userId: string) {
  const membership = await findCommitteeMembership(eventId, userId);
  if (!membership?.active) {
    throw new AppError(
      "Active committee membership required",
      403,
      ErrorCodes.FORBIDDEN,
    );
  }
  return membership;
}

async function listActiveReviewerThemeIds(
  db: typeof prisma | TxClient,
  eventId: string,
  userId: string,
) {
  const rows = await db.abstractReviewerTheme.findMany({
    where: { eventId, userId, active: true },
    select: { themeId: true },
  });
  return (rows ?? []).map((row) => row.themeId);
}

function hasReviewerThemeCoverage(
  abstract: { themes: ThemeLink[] },
  reviewerThemeIds: string[],
) {
  if (reviewerThemeIds.length === 0) return false;
  const covered = new Set(reviewerThemeIds);
  return abstract.themes.some((link) => covered.has(link.theme.id));
}

async function assertAbstractForEvent(abstractId: string, eventId: string) {
  const abstract = await prisma.abstract.findUnique({
    where: { id: abstractId },
  });
  if (!abstract || abstract.eventId !== eventId) {
    throw new AppError("Abstract not found", 404, ErrorCodes.NOT_FOUND);
  }
  return abstract;
}

function getScoreDivergence(scores: number[]): {
  diverged: boolean;
  min: number | null;
  max: number | null;
} {
  if (scores.length < 2) return { diverged: false, min: null, max: null };
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  return { diverged: max - min > 0, min, max };
}

async function notifyScoreDivergence(input: {
  db: typeof prisma | TxClient;
  abstractId: string;
  eventId: string;
  clientId: string;
  averageScore: number | null;
  reviewCount: number;
  scores: number[];
  threshold: number;
}) {
  const { diverged, min, max } = getScoreDivergence(input.scores);
  if (!diverged || min === null || max === null || max - min < input.threshold)
    return;

  const since = new Date(Date.now() - ONE_HOUR_MS);
  const existing = await input.db.emailLog.findFirst({
    where: {
      abstractId: input.abstractId,
      abstractTrigger: "ABSTRACT_SCORE_DIVERGENCE",
      queuedAt: { gte: since },
    },
    select: { id: true },
  });
  if (existing) return;

  const admins = await input.db.user.findMany({
    where: {
      clientId: input.clientId,
      role: UserRole.CLIENT_ADMIN,
      active: true,
    },
    select: { email: true, name: true },
  });

  await Promise.all(
    admins.map((admin) =>
      enqueueAbstractEmailOutboxEvent(
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
        `email:abstract:ABSTRACT_SCORE_DIVERGENCE:${input.abstractId}:${admin.email}`,
      ),
    ),
  );

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

export async function listCommitteeMembers(eventId: string) {
  const memberships = await prisma.abstractCommitteeMembership.findMany({
    where: { eventId, active: true },
    include: {
      user: { select: { id: true, email: true, name: true, active: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const userIds = memberships.map((membership) => membership.userId);
  const [themePrefs, reviewGroups, scoredGroups] = await Promise.all([
    prisma.abstractReviewerTheme.findMany({
      where: { eventId, userId: { in: userIds }, active: true },
      select: { userId: true, themeId: true },
    }),
    prisma.abstractReview.groupBy({
      by: ["reviewerId"],
      where: { eventId, reviewerId: { in: userIds }, active: true },
      _count: { _all: true },
    }),
    prisma.abstractReview.groupBy({
      by: ["reviewerId"],
      where: {
        eventId,
        reviewerId: { in: userIds },
        active: true,
        scoredAt: { not: null },
      },
      _count: { _all: true },
    }),
  ]);

  const themesByUser = new Map<string, string[]>();
  for (const pref of themePrefs) {
    const current = themesByUser.get(pref.userId) ?? [];
    current.push(pref.themeId);
    themesByUser.set(pref.userId, current);
  }
  const assignedByUser = new Map(
    reviewGroups.map((g) => [g.reviewerId, g._count._all]),
  );
  const scoredByUser = new Map(
    scoredGroups.map((g) => [g.reviewerId, g._count._all]),
  );

  return memberships.map((membership) => ({
    userId: membership.userId,
    email: membership.user.email,
    name: membership.user.name,
    active: membership.active,
    themeIds: themesByUser.get(membership.userId) ?? [],
    assignedCount: assignedByUser.get(membership.userId) ?? 0,
    scoredCount: scoredByUser.get(membership.userId) ?? 0,
  }));
}

function generateThrowawayPassword(): string {
  // Random throwaway used to satisfy Firebase Auth's password requirement.
  // The user immediately overwrites it via the reset link in their invite email.
  return `${randomUUID()}A!${randomUUID()}`;
}

/**
 * ActionCodeSettings forwarded with every committee password-reset link.
 * The Firebase Console "Customize action URL" maps the action handler to
 * ${ADMIN_APP_URL}/auth/action; the `url` here is the final post-reset
 * destination Firebase appends as `continueUrl`, *not* another action URL —
 * pointing it back at /auth/action loops the redirect onto a handler page
 * with no oobCode and renders an "unknown mode" error.
 *
 * `handleCodeInApp` is intentionally not set — that flag is for email-link
 * sign-in, not password reset.
 */
function buildPasswordResetActionCodeSettings(): ActionCodeSettings {
  return {
    url: `${config.urls.adminAppUrl}/committee`,
  };
}

const EVENT_NAME_TOKEN = "{eventName}";

interface SendCommitteeMjmlEmailInput {
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
}

/**
 * Shared MJML + SendGrid plumbing for committee transactional emails.
 *
 * All user-controlled strings are HTML-escaped before being interpolated into
 * the MJML template, since MJML treats text as raw markup.
 */
async function sendCommitteeMjmlEmail(
  input: SendCommitteeMjmlEmailInput,
): Promise<boolean> {
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
  // The intro is composed by the caller — it intentionally allows the
  // {eventName} placeholder to render as bold-wrapped, escaped event name.
  // Caller-provided literal text is otherwise already plain English/French.
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
  const result = await sendEmail({
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

async function sendInviteEmail(
  user: Pick<User, "email" | "name">,
  eventName: string,
  link: string,
): Promise<boolean> {
  return sendCommitteeMjmlEmail({
    to: user.email,
    toName: user.name,
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
  });
}

async function sendResetPasswordEmail(
  user: Pick<User, "email" | "name">,
  eventName: string,
  link: string,
): Promise<boolean> {
  return sendCommitteeMjmlEmail({
    to: user.email,
    toName: user.name,
    subject: "Réinitialisation du mot de passe comité",
    headline: "Réinitialiser votre mot de passe comité",
    intro:
      "Une réinitialisation du mot de passe a été demandée pour votre compte comité scientifique sur {eventName}. Utilisez le lien sécurisé ci-dessous pour choisir un nouveau mot de passe :",
    ctaText: "Définir mon mot de passe",
    link,
    eventName,
    category: "committee-password-reset",
    footnote:
      "Si vous n'avez pas demandé cette réinitialisation, vous pouvez ignorer cet email.",
    logContext: "Failed to send committee password-reset email",
  });
}

function assertCommitteeUserEligible(user: User) {
  if (
    user.role === UserRole.SUPER_ADMIN ||
    user.role === UserRole.CLIENT_ADMIN
  ) {
    throw new AppError(
      "This email belongs to an admin account. Admin accounts cannot be added as scientific committee members.",
      400,
      ErrorCodes.VALIDATION_ERROR,
    );
  }
  if (user.role !== UserRole.SCIENTIFIC_COMMITTEE) {
    throw new AppError(
      "This email does not belong to a scientific committee account.",
      400,
      ErrorCodes.VALIDATION_ERROR,
    );
  }
  if (!user.active) {
    throw new AppError(
      "This email belongs to an inactive scientific committee account. Reactivate the account before adding it to an event.",
      400,
      ErrorCodes.VALIDATION_ERROR,
    );
  }
  if (user.clientId !== null) {
    throw new AppError(
      "This email belongs to a client-scoped account. Only unscoped scientific committee accounts can be added as committee members.",
      400,
      ErrorCodes.VALIDATION_ERROR,
    );
  }
}

export async function addCommitteeMember(
  eventId: string,
  body: AddCommitteeMemberInput,
  performedBy: string,
) {
  let createdUser = false;
  let existingUserAdded = false;
  let user: User | null;

  if ("userId" in body) {
    user = await prisma.user.findUnique({ where: { id: body.userId } });
  } else {
    const existingUser = await prisma.user.findUnique({
      where: { email: body.email },
    });
    if (existingUser) {
      user = existingUser;
      existingUserAdded = true;
    } else {
      user = await createUser({
        email: body.email,
        name: body.name,
        password: generateThrowawayPassword(),
        role: UserRole.SCIENTIFIC_COMMITTEE,
        clientId: null,
      });
      createdUser = true;
    }
  }

  if (!user) throw new AppError("User not found", 404, ErrorCodes.NOT_FOUND);
  assertCommitteeUserEligible(user);

  await prisma.abstractCommitteeMembership.upsert({
    where: { userId_eventId: { userId: user.id, eventId } },
    update: { active: true },
    create: { userId: user.id, eventId, active: true },
  });

  await auditLog(prisma, {
    entityType: "AbstractCommitteeMembership",
    entityId: `${eventId}:${user.id}`,
    action: "upsert",
    changes: { active: { old: null, new: true } },
    performedBy,
  });

  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { name: true },
  });
  // Best-effort: invite delivery failure is reported back to the caller but
  // doesn't roll the membership back. The admin sees a warning and can resend.
  const inviteEmailSent = await (async () => {
    try {
      const link = await generatePasswordResetLink(
        user.email,
        buildPasswordResetActionCodeSettings(),
      );
      return await sendInviteEmail(user, event?.name ?? "the event", link);
    } catch (err) {
      logger.error(
        { err, userId: user.id, eventId, createdUser },
        "Committee invite email threw while sending",
      );
      return false;
    }
  })();

  const member = (await listCommitteeMembers(eventId)).find(
    (m) => m.userId === user.id,
  ) ?? {
    userId: user.id,
    email: user.email,
    name: user.name,
    active: true,
    themeIds: [],
    assignedCount: 0,
    scoredCount: 0,
  };
  return {
    ...member,
    inviteEmailSent,
    ...(existingUserAdded ? { existingUserAdded } : {}),
  };
}

export async function removeCommitteeMember(
  eventId: string,
  userId: string,
  performedBy: string,
) {
  await assertActiveMembership(eventId, userId);
  await prisma.$transaction([
    prisma.abstractCommitteeMembership.update({
      where: { userId_eventId: { userId, eventId } },
      data: { active: false },
    }),
    prisma.abstractReviewerTheme.updateMany({
      where: { eventId, userId },
      data: { active: false },
    }),
  ]);
  await auditLog(prisma, {
    entityType: "AbstractCommitteeMembership",
    entityId: `${eventId}:${userId}`,
    action: "deactivate",
    changes: { active: { old: true, new: false } },
    performedBy,
  });
}

export async function setReviewerThemes(
  eventId: string,
  userId: string,
  body: SetReviewerThemesInput,
  performedBy: string,
) {
  await assertActiveMembership(eventId, userId);
  const uniqueThemeIds = [...new Set(body.themeIds)];
  const config = await prisma.abstractConfig.findUnique({
    where: { eventId },
    include: { themes: { where: { active: true }, select: { id: true } } },
  });
  if (!config)
    throw new AppError("Abstract config not found", 404, ErrorCodes.NOT_FOUND);
  const activeThemeIds = new Set(config.themes.map((theme) => theme.id));
  if (uniqueThemeIds.some((themeId) => !activeThemeIds.has(themeId))) {
    throw new AppError(
      "Invalid abstract themes",
      400,
      ErrorCodes.ABSTRACT_INVALID_THEMES,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.abstractReviewerTheme.updateMany({
      where: { eventId, userId },
      data: { active: false },
    });
    for (const themeId of uniqueThemeIds) {
      await tx.abstractReviewerTheme.upsert({
        where: { userId_eventId_themeId: { userId, eventId, themeId } },
        update: { active: true },
        create: { userId, eventId, themeId, active: true },
      });
    }
  });

  await auditLog(prisma, {
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
    throw new AppError("Committee member not found", 404, ErrorCodes.NOT_FOUND);
  }
  return member;
}

export async function assignReviewers(
  eventId: string,
  abstractId: string,
  body: AssignReviewersInput,
  performedBy: string,
) {
  const abstract = await assertAbstractForEvent(abstractId, eventId);
  const reviewerIds = [...new Set(body.reviewerIds)];
  const config = await prisma.abstractConfig.findUnique({
    where: { eventId },
    select: { reviewersPerAbstract: true, divergenceThreshold: true },
  });
  const requiredReviewers = config?.reviewersPerAbstract ?? 2;

  if (reviewerIds.length > 0) {
    if (reviewerIds.length < requiredReviewers) {
      throw new AppError(
        `Exactly ${requiredReviewers} reviewers are required for initial assignment`,
        400,
        ErrorCodes.VALIDATION_ERROR,
      );
    }

    if (reviewerIds.length > requiredReviewers) {
      const scoredReviews = await prisma.abstractReview.findMany({
        where: { abstractId, active: true, score: { not: null } },
        select: { score: true },
      });
      const scores = scoredReviews
        .map((review) => review.score)
        .filter((score): score is number => score !== null);
      const min = scores.length >= 2 ? Math.min(...scores) : null;
      const max = scores.length >= 2 ? Math.max(...scores) : null;
      const spread = min !== null && max !== null ? max - min : 0;
      if (spread < (config?.divergenceThreshold ?? 6)) {
        throw new AppError(
          "Extra reviewers can only be assigned after a score divergence alert",
          400,
          ErrorCodes.VALIDATION_ERROR,
        );
      }
    }

    const memberships = await prisma.abstractCommitteeMembership.findMany({
      where: { eventId, userId: { in: reviewerIds }, active: true },
      select: { userId: true },
    });
    const activeMemberIds = new Set(
      memberships.map((membership) => membership.userId),
    );
    if (reviewerIds.some((reviewerId) => !activeMemberIds.has(reviewerId))) {
      throw new AppError(
        "All reviewers must have active membership",
        400,
        ErrorCodes.VALIDATION_ERROR,
      );
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.abstractReview.updateMany({
      where: {
        abstractId,
        active: true,
        reviewerId: { notIn: reviewerIds },
      },
      data: { active: false },
    });

    for (const reviewerId of reviewerIds) {
      await tx.abstractReview.upsert({
        where: { abstractId_reviewerId: { abstractId, reviewerId } },
        update: { eventId, active: true },
        create: { abstractId, eventId, reviewerId, active: true },
      });
    }

    const nextStatus =
      reviewerIds.length > 0 && abstract.status === AbstractStatus.SUBMITTED
        ? AbstractStatus.UNDER_REVIEW
        : abstract.status;

    return tx.abstract.update({
      where: { id: abstractId },
      data: { status: nextStatus },
      select: { id: true, status: true },
    });
  });

  await auditLog(prisma, {
    entityType: "Abstract",
    entityId: abstractId,
    action: "assign_reviewers",
    changes: { reviewerIds: { old: null, new: reviewerIds } },
    performedBy,
  });

  return { abstractId: updated.id, status: updated.status, reviewerIds };
}

export async function getCommitteeProfile(userId: string) {
  const memberships = await prisma.abstractCommitteeMembership.findMany({
    where: { userId, active: true },
    include: { event: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const eventIds = memberships.map((membership) => membership.eventId);
  const [assignedGroups, scoredGroups] = await Promise.all([
    prisma.abstractReview.groupBy({
      by: ["eventId"],
      where: { reviewerId: userId, eventId: { in: eventIds }, active: true },
      _count: { _all: true },
    }),
    prisma.abstractReview.groupBy({
      by: ["eventId"],
      where: {
        reviewerId: userId,
        eventId: { in: eventIds },
        active: true,
        scoredAt: { not: null },
      },
      _count: { _all: true },
    }),
  ]);
  const assignedByEvent = new Map(
    assignedGroups.map((g) => [g.eventId, g._count._all]),
  );
  const scoredByEvent = new Map(
    scoredGroups.map((g) => [g.eventId, g._count._all]),
  );

  return {
    events: memberships.map((membership) => ({
      eventId: membership.eventId,
      eventName: membership.event.name,
      assignedCount: assignedByEvent.get(membership.eventId) ?? 0,
      scoredCount: scoredByEvent.get(membership.eventId) ?? 0,
    })),
  };
}

export async function listAssignedAbstracts(
  eventId: string,
  reviewerId: string,
) {
  await assertActiveMembership(eventId, reviewerId);
  const reviewerThemeIds = await listActiveReviewerThemeIds(
    prisma,
    eventId,
    reviewerId,
  );
  const assignmentFilters: Prisma.AbstractWhereInput[] = [
    { reviews: { some: { reviewerId, eventId, active: true } } },
  ];
  if (reviewerThemeIds.length > 0) {
    assignmentFilters.push({
      themes: { some: { themeId: { in: reviewerThemeIds } } },
    });
  }
  const abstracts = await prisma.abstract.findMany({
    where: {
      eventId,
      OR: assignmentFilters,
    },
    include: {
      themes: { include: { theme: { select: { id: true, label: true } } } },
      reviews: { where: { active: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return abstracts.map((abstract) =>
    anonymizeAbstractListItem(abstract, reviewerId),
  );
}

export async function getAssignedAbstractDetail(
  abstractId: string,
  reviewerId: string,
) {
  const abstract = await prisma.abstract.findUnique({
    where: { id: abstractId },
    include: {
      themes: { include: { theme: { select: { id: true, label: true } } } },
      reviews: { where: { active: true } },
    },
  });
  if (!abstract)
    throw new AppError("Abstract not found", 404, ErrorCodes.NOT_FOUND);
  await assertActiveMembership(abstract.eventId, reviewerId);
  const reviewerThemeIds = await listActiveReviewerThemeIds(
    prisma,
    abstract.eventId,
    reviewerId,
  );
  if (
    !abstract.reviews.some(
      (review) => review.reviewerId === reviewerId && review.active,
    ) &&
    !hasReviewerThemeCoverage(abstract, reviewerThemeIds)
  ) {
    throw new AppError(
      "Abstract assignment not found",
      404,
      ErrorCodes.NOT_FOUND,
    );
  }
  return anonymizeAbstractDetail(abstract, reviewerId);
}

export async function reviewAssignedAbstract(
  abstractId: string,
  reviewerId: string,
  body: ReviewAbstractInput,
) {
  const abstract = await prisma.abstract.findUnique({
    where: { id: abstractId },
    include: {
      event: {
        select: {
          clientId: true,
          abstractConfig: {
            select: {
              scoringStartAt: true,
              scoringDeadline: true,
              divergenceThreshold: true,
              commentsEnabled: true,
            },
          },
        },
      },
      themes: { include: { theme: { select: { id: true, label: true } } } },
      reviews: { where: { active: true } },
    },
  });
  if (!abstract)
    throw new AppError("Abstract not found", 404, ErrorCodes.NOT_FOUND);
  await assertActiveMembership(abstract.eventId, reviewerId);
  const reviewerThemeIds = await listActiveReviewerThemeIds(
    prisma,
    abstract.eventId,
    reviewerId,
  );
  if (FINAL_STATUSES.includes(abstract.status)) {
    throw new AppError(
      "Abstract is not open for scoring",
      409,
      ErrorCodes.INVALID_STATUS_TRANSITION,
    );
  }
  const deadline = abstract.event.abstractConfig?.scoringDeadline;
  const startAt = abstract.event.abstractConfig?.scoringStartAt;
  if (startAt && startAt.getTime() > Date.now()) {
    throw new AppError(
      "Scoring has not started yet",
      403,
      ErrorCodes.FORBIDDEN,
    );
  }
  if (deadline && deadline.getTime() < Date.now()) {
    throw new AppError(
      "Scoring deadline has passed",
      403,
      ErrorCodes.FORBIDDEN,
    );
  }
  if (
    abstract.event.abstractConfig?.commentsEnabled === false &&
    body.comment?.trim()
  ) {
    throw new AppError(
      "Reviewer comments are disabled for this event",
      400,
      ErrorCodes.VALIDATION_ERROR,
    );
  }
  if (
    !abstract.reviews.some(
      (review) => review.reviewerId === reviewerId && review.active,
    ) &&
    !hasReviewerThemeCoverage(abstract, reviewerThemeIds)
  ) {
    throw new AppError(
      "Abstract assignment not found",
      404,
      ErrorCodes.NOT_FOUND,
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.abstractReview.upsert({
      where: { abstractId_reviewerId: { abstractId, reviewerId } },
      update: {
        eventId: abstract.eventId,
        active: true,
        score: body.score,
        comment:
          abstract.event.abstractConfig?.commentsEnabled === false
            ? null
            : (body.comment ?? null),
        scoredAt: new Date(),
      },
      create: {
        abstractId,
        eventId: abstract.eventId,
        reviewerId,
        active: true,
        score: body.score,
        comment:
          abstract.event.abstractConfig?.commentsEnabled === false
            ? null
            : (body.comment ?? null),
        scoredAt: new Date(),
      },
    });

    const assignments = await tx.abstractReview.findMany({
      where: { abstractId, active: true },
      select: { scoredAt: true, score: true },
    });
    const scores = assignments
      .map((review) => review.score)
      .filter((score): score is number => score !== null);
    const reviewCount = assignments.filter(
      (review) => review.scoredAt !== null,
    ).length;
    const averageScore = scores.length
      ? scores.reduce((sum, score) => sum + score, 0) / scores.length
      : null;
    const allScored =
      assignments.length > 0 &&
      assignments.every((review) => review.scoredAt !== null);
    const status = allScored
      ? AbstractStatus.REVIEW_COMPLETE
      : AbstractStatus.UNDER_REVIEW;

    const updatedAbstract = await tx.abstract.update({
      where: { id: abstractId },
      data: { averageScore, reviewCount, status },
      select: { id: true, status: true, averageScore: true, reviewCount: true },
    });

    await auditLog(tx, {
      entityType: "AbstractReview",
      entityId: abstractId,
      action: "score",
      changes: { score: { old: null, new: body.score } },
      performedBy: reviewerId,
    });

    if (updatedAbstract.status === AbstractStatus.REVIEW_COMPLETE) {
      await enqueueRealtimeOutboxEvent(tx, {
        type: "abstract.reviewCompleted",
        clientId: abstract.event.clientId,
        eventId: abstract.eventId,
        payload: {
          id: updatedAbstract.id,
          status: updatedAbstract.status,
          averageScore: updatedAbstract.averageScore,
          reviewCount: updatedAbstract.reviewCount,
        },
        ts: Date.now(),
      });
    }

    await notifyScoreDivergence({
      db: tx,
      abstractId,
      eventId: abstract.eventId,
      clientId: abstract.event.clientId,
      averageScore: updatedAbstract.averageScore,
      reviewCount: updatedAbstract.reviewCount,
      scores,
      threshold: abstract.event.abstractConfig?.divergenceThreshold ?? 6,
    });

    return { ...updatedAbstract, scores };
  });

  const { scores: _scores, ...response } = result;
  void _scores;
  return response;
}

/**
 * Stricter cousin of {@link assertActiveMembership} for admin-triggered
 * password operations. Returns 404 (vs. 403) because the admin context is
 * "this committee member doesn't exist on this event", not "the caller lacks
 * permission".
 */
async function assertCommitteeMemberExists(eventId: string, userId: string) {
  const membership = await findCommitteeMembership(eventId, userId);
  if (!membership?.active) {
    throw new AppError("Committee member not found", 404, ErrorCodes.NOT_FOUND);
  }
  return membership;
}

/**
 * Re-issue a password-reset link for a committee member and email it to them.
 * Used by admins to unblock members who lost the original invite email.
 *
 * The link itself is generated by Firebase regardless of whether SendGrid
 * delivers the email; we audit-log the admin's intent and report the email
 * outcome to the caller so the UI can surface a warning when delivery fails.
 */
export async function resendCommitteeInvite(
  eventId: string,
  userId: string,
  performedBy: string,
) {
  const membership = await prisma.abstractCommitteeMembership.findUnique({
    where: { userId_eventId: { userId, eventId } },
    select: {
      active: true,
      user: { select: { email: true, name: true } },
      event: { select: { name: true } },
    },
  });
  if (!membership?.active) {
    throw new AppError("Committee member not found", 404, ErrorCodes.NOT_FOUND);
  }

  let inviteEmailSent = false;
  try {
    const link = await generatePasswordResetLink(
      membership.user.email,
      buildPasswordResetActionCodeSettings(),
    );
    inviteEmailSent = await sendResetPasswordEmail(
      membership.user,
      membership.event.name,
      link,
    );
  } catch (err) {
    logger.error(
      { err, userId, eventId },
      "Committee reset-password email threw while sending",
    );
    inviteEmailSent = false;
  }

  await auditLog(prisma, {
    entityType: "User",
    entityId: userId,
    action: "admin_reset_password",
    changes: { method: { old: null, new: "email_link" } },
    performedBy,
  });

  return { inviteEmailSent };
}

/**
 * Direct admin override: set a Firebase Auth user's password and revoke all
 * refresh tokens so existing sessions cannot keep refreshing ID tokens with
 * the stale credential context. The plaintext password never enters the
 * audit log.
 */
export async function setCommitteeMemberPassword(
  eventId: string,
  userId: string,
  newPassword: string,
  performedBy: string,
) {
  await assertCommitteeMemberExists(eventId, userId);

  await updateFirebaseUserPassword(userId, newPassword);
  await revokeFirebaseRefreshTokens(userId);

  await auditLog(prisma, {
    entityType: "User",
    entityId: userId,
    action: "admin_reset_password",
    changes: { method: { old: null, new: "direct" } },
    performedBy,
  });

  return { ok: true as const };
}
