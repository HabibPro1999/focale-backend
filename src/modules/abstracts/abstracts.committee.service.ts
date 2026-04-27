import { prisma } from "@/database/client.js";
import {
  AbstractStatus,
  Prisma,
  type Abstract,
  type AbstractReview,
  type AbstractTheme,
} from "@/generated/prisma/client.js";
import { createUser } from "@modules/identity/users.service.js";
import { UserRole } from "@shared/constants/roles.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { auditLog } from "@shared/utils/audit.js";
import { eventBus } from "@core/events/bus.js";
import { queueAbstractEmail } from "./abstracts.email-queue.js";
import type {
  AddCommitteeMemberInput,
  AssignReviewersInput,
  ReviewAbstractInput,
  SetReviewerThemesInput,
} from "./abstracts.schema.js";

const FINAL_STATUSES: AbstractStatus[] = [
  AbstractStatus.ACCEPTED,
  AbstractStatus.REJECTED,
  AbstractStatus.PENDING,
];

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

async function assertActiveMembership(eventId: string, userId: string) {
  const membership = await prisma.abstractCommitteeMembership.findUnique({
    where: { userId_eventId: { userId, eventId } },
  });
  if (!membership?.active) {
    throw new AppError("Active committee membership required", 403, ErrorCodes.FORBIDDEN);
  }
  return membership;
}

async function assertAbstractForEvent(abstractId: string, eventId: string) {
  const abstract = await prisma.abstract.findUnique({ where: { id: abstractId } });
  if (!abstract || abstract.eventId !== eventId) {
    throw new AppError("Abstract not found", 404, ErrorCodes.NOT_FOUND);
  }
  return abstract;
}

function getScoreDivergence(scores: number[]): { diverged: boolean; min: number | null; max: number | null } {
  if (scores.length < 2) return { diverged: false, min: null, max: null };
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  return { diverged: max - min > 0, min, max };
}

async function notifyScoreDivergence(input: {
  abstractId: string;
  eventId: string;
  clientId: string;
  averageScore: number | null;
  reviewCount: number;
  scores: number[];
  threshold: number;
}) {
  const { diverged, min, max } = getScoreDivergence(input.scores);
  if (!diverged || min === null || max === null || max - min <= input.threshold) return;

  const since = new Date(Date.now() - ONE_HOUR_MS);
  const existing = await prisma.emailLog.findFirst({
    where: {
      abstractId: input.abstractId,
      abstractTrigger: "ABSTRACT_SCORE_DIVERGENCE",
      queuedAt: { gte: since },
    },
    select: { id: true },
  });
  if (existing) return;

  const admins = await prisma.user.findMany({
    where: {
      clientId: input.clientId,
      role: UserRole.CLIENT_ADMIN,
      active: true,
    },
    select: { email: true, name: true },
  });

  await Promise.all(
    admins.map((admin) =>
      queueAbstractEmail({
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
      }),
    ),
  );

  eventBus.emit({
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
  const assignedByUser = new Map(reviewGroups.map((g) => [g.reviewerId, g._count._all]));
  const scoredByUser = new Map(scoredGroups.map((g) => [g.reviewerId, g._count._all]));

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

export async function addCommitteeMember(
  eventId: string,
  body: AddCommitteeMemberInput,
  performedBy: string,
) {
  const user = "userId" in body
    ? await prisma.user.findUnique({ where: { id: body.userId } })
    : await createUser({
        email: body.email,
        name: body.name,
        password: body.password,
        role: UserRole.SCIENTIFIC_COMMITTEE,
        clientId: null,
      });

  if (!user) throw new AppError("User not found", 404, ErrorCodes.NOT_FOUND);
  if (
    user.role !== UserRole.SCIENTIFIC_COMMITTEE ||
    !user.active ||
    user.clientId !== null
  ) {
    throw new AppError(
      "Committee member must be an active unscoped scientific committee user",
      400,
      ErrorCodes.VALIDATION_ERROR,
    );
  }

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

  const member = (await listCommitteeMembers(eventId)).find((m) => m.userId === user.id);
  return member ?? {
    userId: user.id,
    email: user.email,
    name: user.name,
    active: true,
    themeIds: [],
    assignedCount: 0,
    scoredCount: 0,
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
  if (!config) throw new AppError("Abstract config not found", 404, ErrorCodes.NOT_FOUND);
  const activeThemeIds = new Set(config.themes.map((theme) => theme.id));
  if (uniqueThemeIds.some((themeId) => !activeThemeIds.has(themeId))) {
    throw new AppError("Invalid abstract themes", 400, ErrorCodes.ABSTRACT_INVALID_THEMES);
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

  const member = (await listCommitteeMembers(eventId)).find((m) => m.userId === userId);
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

  if (reviewerIds.length > 0) {
    const memberships = await prisma.abstractCommitteeMembership.findMany({
      where: { eventId, userId: { in: reviewerIds }, active: true },
      select: { userId: true },
    });
    const activeMemberIds = new Set(memberships.map((membership) => membership.userId));
    if (reviewerIds.some((reviewerId) => !activeMemberIds.has(reviewerId))) {
      throw new AppError("All reviewers must have active membership", 400, ErrorCodes.VALIDATION_ERROR);
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
  const assignedByEvent = new Map(assignedGroups.map((g) => [g.eventId, g._count._all]));
  const scoredByEvent = new Map(scoredGroups.map((g) => [g.eventId, g._count._all]));

  return {
    events: memberships.map((membership) => ({
      eventId: membership.eventId,
      eventName: membership.event.name,
      assignedCount: assignedByEvent.get(membership.eventId) ?? 0,
      scoredCount: scoredByEvent.get(membership.eventId) ?? 0,
    })),
  };
}

export async function listAssignedAbstracts(eventId: string, reviewerId: string) {
  await assertActiveMembership(eventId, reviewerId);
  const abstracts = await prisma.abstract.findMany({
    where: { eventId, reviews: { some: { reviewerId, eventId, active: true } } },
    include: {
      themes: { include: { theme: { select: { id: true, label: true } } } },
      reviews: { where: { active: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return abstracts.map((abstract) => anonymizeAbstractListItem(abstract, reviewerId));
}

export async function getAssignedAbstractDetail(abstractId: string, reviewerId: string) {
  const abstract = await prisma.abstract.findUnique({
    where: { id: abstractId },
    include: {
      themes: { include: { theme: { select: { id: true, label: true } } } },
      reviews: { where: { active: true } },
    },
  });
  if (!abstract) throw new AppError("Abstract not found", 404, ErrorCodes.NOT_FOUND);
  await assertActiveMembership(abstract.eventId, reviewerId);
  if (!abstract.reviews.some((review) => review.reviewerId === reviewerId && review.active)) {
    throw new AppError("Abstract assignment not found", 404, ErrorCodes.NOT_FOUND);
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
          abstractConfig: { select: { scoringDeadline: true, divergenceThreshold: true } },
        },
      },
      reviews: { where: { active: true } },
    },
  });
  if (!abstract) throw new AppError("Abstract not found", 404, ErrorCodes.NOT_FOUND);
  await assertActiveMembership(abstract.eventId, reviewerId);
  if (FINAL_STATUSES.includes(abstract.status)) {
    throw new AppError("Abstract is not open for scoring", 409, ErrorCodes.INVALID_STATUS_TRANSITION);
  }
  const deadline = abstract.event.abstractConfig?.scoringDeadline;
  if (deadline && deadline.getTime() < Date.now()) {
    throw new AppError("Scoring deadline has passed", 403, ErrorCodes.FORBIDDEN);
  }
  if (!abstract.reviews.some((review) => review.reviewerId === reviewerId && review.active)) {
    throw new AppError("Abstract assignment not found", 404, ErrorCodes.NOT_FOUND);
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.abstractReview.update({
      where: { abstractId_reviewerId: { abstractId, reviewerId } },
      data: {
        eventId: abstract.eventId,
        active: true,
        score: body.score,
        comment: body.comment ?? null,
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
    const reviewCount = assignments.filter((review) => review.scoredAt !== null).length;
    const averageScore = scores.length
      ? scores.reduce((sum, score) => sum + score, 0) / scores.length
      : null;
    const allScored = assignments.length > 0 && assignments.every((review) => review.scoredAt !== null);
    const status = allScored ? AbstractStatus.REVIEW_COMPLETE : AbstractStatus.UNDER_REVIEW;

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

    return { ...updatedAbstract, scores };
  });


  if (result.status === AbstractStatus.REVIEW_COMPLETE) {
    eventBus.emit({
      type: "abstract.reviewCompleted",
      clientId: abstract.event.clientId,
      eventId: abstract.eventId,
      payload: {
        id: result.id,
        status: result.status,
        averageScore: result.averageScore,
        reviewCount: result.reviewCount,
      },
      ts: Date.now(),
    });
  }

  await notifyScoreDivergence({
    abstractId,
    eventId: abstract.eventId,
    clientId: abstract.event.clientId,
    averageScore: result.averageScore,
    reviewCount: result.reviewCount,
    scores: result.scores,
    threshold: abstract.event.abstractConfig?.divergenceThreshold ?? 6,
  });
  const { scores: _scores, ...response } = result;
  void _scores;
  return response;
}
