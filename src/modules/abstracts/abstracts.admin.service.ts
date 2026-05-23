import { prisma } from "@/database/client.js";
import {
  AbstractFinalType,
  AbstractStatus,
  Prisma,
  type AbstractReview,
} from "@/generated/prisma/client.js";
import {
  enqueueAbstractEmailOutboxEvent,
  enqueueRealtimeOutboxEvent,
} from "@core/outbox";
import type { TxClient } from "@shared/types/prisma.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { auditLog } from "@shared/utils/audit.js";
import type {
  FinalizeAbstractInput,
  ListAbstractsQuery,
} from "./abstracts.schema.js";
import { FINAL_STATUSES, CODE_SUFFIX } from "./abstracts.constants.js";

type AbstractContent = { title?: unknown } & Record<string, unknown>;
type Tx = TxClient;

function getTitle(content: Prisma.JsonValue): string {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const title = (content as AbstractContent).title;
    if (typeof title === "string" && title.trim()) return title.trim();
  }
  return "Untitled abstract";
}

function toReviewDto(review: AbstractReview & {
  reviewer: { id: string; name: string | null; email: string };
}) {
  return {
    id: review.id,
    reviewerId: review.reviewerId,
    reviewerName: review.reviewer.name,
    reviewerEmail: review.reviewer.email,
    score: review.score,
    comment: review.comment,
    scoredAt: review.scoredAt?.toISOString() ?? null,
    active: review.active,
  };
}

function reviewScoreSpread(
  reviews: Array<{ score: number | null }>,
): { min: number | null; max: number | null; spread: number | null } {
  const scores = reviews
    .map((review) => review.score)
    .filter((score): score is number => score !== null);
  if (scores.length < 2) return { min: null, max: null, spread: null };
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  return { min, max, spread: max - min };
}

function formatAdminAbstract(abstract: Prisma.AbstractGetPayload<{
  include: {
    themes: { include: { theme: { select: { id: true; label: true } } } };
    reviews: { include: { reviewer: { select: { id: true; name: true; email: true } } } };
  };
}>) {
  return {
    id: abstract.id,
    eventId: abstract.eventId,
    status: abstract.status,
    code: abstract.code,
    codeNumber: abstract.codeNumber,
    title: getTitle(abstract.content),
    requestedType: abstract.requestedType,
    finalType: abstract.finalType,
    presentedAt: abstract.presentedAt?.toISOString() ?? null,
    presentedBy: abstract.presentedBy,
    authorFirstName: abstract.authorFirstName,
    authorLastName: abstract.authorLastName,
    authorEmail: abstract.authorEmail,
    authorPhone: abstract.authorPhone,
    averageScore: abstract.averageScore,
    reviewCount: abstract.reviewCount,
    themeLabels: abstract.themes.map((link) => link.theme.label),
    themeIds: abstract.themes.map((link) => link.theme.id),
    reviews: abstract.reviews.map(toReviewDto),
    scoreSpread: reviewScoreSpread(abstract.reviews),
    createdAt: abstract.createdAt.toISOString(),
    updatedAt: abstract.updatedAt.toISOString(),
    lastEditedAt: abstract.lastEditedAt?.toISOString() ?? null,
  };
}

async function allocateAbstractCode(
  tx: Tx,
  eventId: string,
  finalType: AbstractFinalType,
  theme: { id: string; sortOrder: number },
): Promise<{ code: string; codeNumber: number }> {
  const seeded = await tx.abstract.aggregate({
    where: {
      eventId,
      finalType,
      codeNumber: { not: null },
      themes: { some: { themeId: theme.id } },
    },
    _max: { codeNumber: true },
  });
  const seedValue = seeded._max.codeNumber ?? 0;
  const counter = await tx.abstractCodeCounter.upsert({
    where: { eventId_themeId_finalType: { eventId, themeId: theme.id, finalType } },
    update: { lastValue: { increment: 1 } },
    create: { eventId, themeId: theme.id, finalType, lastValue: seedValue + 1 },
    select: { lastValue: true },
  });
  const codeNumber = counter.lastValue;
  const code = `${CODE_SUFFIX[finalType]}${theme.sortOrder}-${String(codeNumber).padStart(2, "0")}`;
  return { code, codeNumber };
}

function collectCommitteeComments(
  reviews: Array<{ reviewer: { name: string | null }; comment: string | null }>,
): string {
  const comments = reviews
    .map((review, index) => {
      const comment = review.comment?.trim();
      if (!comment) return null;
      const label = review.reviewer.name?.trim() || `Reviewer ${index + 1}`;
      return `${label}: ${comment}`;
    })
    .filter((comment): comment is string => Boolean(comment));
  return comments.join("\n\n");
}

export async function listAdminAbstracts(
  eventId: string,
  query: ListAbstractsQuery = {},
) {
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;
  const where: Prisma.AbstractWhereInput = {
    eventId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.themeId
      ? { themes: { some: { themeId: query.themeId } } }
      : {}),
    ...(query.reviewerId
      ? { reviews: { some: { reviewerId: query.reviewerId, active: true } } }
      : {}),
  };

  if (query.q?.trim()) {
    const q = query.q.trim();
    where.OR = [
      { authorFirstName: { contains: q } },
      { authorLastName: { contains: q } },
      { authorEmail: { contains: q } },
      { code: { contains: q } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.abstract.findMany({
      where,
      include: {
        themes: { include: { theme: { select: { id: true, label: true } } } },
        reviews: {
          where: { active: true },
          include: { reviewer: { select: { id: true, name: true, email: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.abstract.count({ where }),
  ]);

  return {
    items: items.map(formatAdminAbstract),
    total,
    limit,
    offset,
  };
}

export async function getAdminAbstract(eventId: string, abstractId: string) {
  const abstract = await prisma.abstract.findUnique({
    where: { id: abstractId },
    include: {
      themes: { include: { theme: { select: { id: true, label: true } } } },
      reviews: {
        include: { reviewer: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: "asc" },
      },
      revisions: { orderBy: { revisionNo: "desc" } },
    },
  });

  if (!abstract || abstract.eventId !== eventId) {
    throw new AppError("Abstract not found", 404, ErrorCodes.NOT_FOUND);
  }

  return {
    ...formatAdminAbstract({
      ...abstract,
      reviews: abstract.reviews.filter((review) => review.active),
    }),
    content: abstract.content,
    coAuthors: abstract.coAuthors,
    additionalFieldsData: abstract.additionalFieldsData,
    registrationId: abstract.registrationId,
    finalFile: {
      key: abstract.finalFileKey,
      kind: abstract.finalFileKind,
      size: abstract.finalFileSize,
      uploadedAt: abstract.finalFileUploadedAt?.toISOString() ?? null,
    },
    revisions: abstract.revisions.map((revision) => ({
      id: revision.id,
      revisionNo: revision.revisionNo,
      snapshot: revision.snapshot,
      editedBy: revision.editedBy,
      editedIpAddress: revision.editedIpAddress,
      content: revision.content,
      coAuthors: revision.coAuthors,
      additionalFieldsData: revision.additionalFieldsData,
      createdAt: revision.createdAt.toISOString(),
    })),
  };
}

export async function finalizeAbstract(
  eventId: string,
  abstractId: string,
  input: FinalizeAbstractInput,
  performedBy: string,
) {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.abstract.findUnique({
      where: { id: abstractId },
      include: {
        event: {
          select: {
            clientId: true,
            abstractConfig: {
              select: {
                commentsEnabled: true,
                commentsSentToAuthor: true,
                finalFileUploadEnabled: true,
              },
            },
          },
        },
        reviews: {
          where: { active: true },
          include: { reviewer: { select: { name: true } } },
          orderBy: { createdAt: "asc" },
        },
        themes: {
          include: {
            theme: { select: { id: true, sortOrder: true } },
          },
          orderBy: { theme: { sortOrder: "asc" } },
        },
      },
    });

    if (!existing || existing.eventId !== eventId) {
      throw new AppError("Abstract not found", 404, ErrorCodes.NOT_FOUND);
    }
    if (FINAL_STATUSES.includes(existing.status)) {
      throw new AppError(
        "Abstract is already finalized; reopen before changing the decision",
        409,
        ErrorCodes.INVALID_STATUS_TRANSITION,
      );
    }
    if (input.decision === AbstractStatus.ACCEPTED && !input.finalType) {
      throw new AppError(
        "Final presentation type is required when accepting an abstract",
        400,
        ErrorCodes.VALIDATION_ERROR,
      );
    }

    const nextData: Prisma.AbstractUpdateInput = {
      status: input.decision,
      finalType: input.decision === AbstractStatus.ACCEPTED ? input.finalType : null,
    };

    let allocatedCode: { code: string; codeNumber: number } | null = null;
    if (input.decision === AbstractStatus.ACCEPTED) {
      const codeTheme = existing.themes[0]?.theme;
      if (!codeTheme) {
        throw new AppError(
          "Accepted abstracts must have a theme before a code can be allocated",
          400,
          ErrorCodes.ABSTRACT_INVALID_THEMES,
        );
      }
      if (existing.codeNumber != null) {
        const code = `${CODE_SUFFIX[input.finalType!]}${codeTheme.sortOrder}-${String(existing.codeNumber).padStart(2, "0")}`;
        allocatedCode = { code, codeNumber: existing.codeNumber };
      } else {
        allocatedCode = await allocateAbstractCode(tx, eventId, input.finalType!, codeTheme);
      }
      nextData.code = allocatedCode.code;
      nextData.codeNumber = allocatedCode.codeNumber;
    } else {
      nextData.code = null;
      nextData.codeNumber = null;
    }

    const updated = await tx.abstract.update({
      where: { id: abstractId, status: { notIn: FINAL_STATUSES } },
      data: nextData,
      select: {
        id: true,
        eventId: true,
        status: true,
        finalType: true,
        code: true,
        codeNumber: true,
        averageScore: true,
        reviewCount: true,
      },
    }).catch((e: unknown) => {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
        throw new AppError(
          "Abstract is already finalized; reopen before changing the decision",
          409,
          ErrorCodes.INVALID_STATUS_TRANSITION,
        );
      }
      throw e;
    });

    await auditLog(tx, {
      entityType: "Abstract",
      entityId: abstractId,
      action: "finalize",
      changes: {
        status: { old: existing.status, new: input.decision },
        finalType: { old: existing.finalType, new: input.finalType ?? null },
        code: { old: existing.code, new: allocatedCode?.code ?? null },
      },
      performedBy,
    });

    await enqueueAbstractEmailOutboxEvent(
      tx,
      {
        trigger: "ABSTRACT_DECISION",
        abstractId,
      },
      `email:abstract:ABSTRACT_DECISION:${abstractId}`,
    );

    if (
      existing.event.abstractConfig?.commentsEnabled &&
      existing.event.abstractConfig.commentsSentToAuthor
    ) {
      const committeeComments = collectCommitteeComments(existing.reviews);
      if (committeeComments) {
        await enqueueAbstractEmailOutboxEvent(
          tx,
          {
            trigger: "ABSTRACT_COMMITTEE_COMMENTS",
            abstractId,
            extraContext: {
              committeeComments,
            },
          },
          `email:abstract:ABSTRACT_COMMITTEE_COMMENTS:${abstractId}`,
        );
      }
    }

    if (
      updated.status === AbstractStatus.ACCEPTED &&
      existing.event.abstractConfig?.finalFileUploadEnabled
    ) {
      await enqueueAbstractEmailOutboxEvent(
        tx,
        {
          trigger: "ABSTRACT_FINAL_FILE_REQUEST",
          abstractId,
        },
        `email:abstract:ABSTRACT_FINAL_FILE_REQUEST:${abstractId}`,
      );
    }

    await enqueueRealtimeOutboxEvent(tx, {
      type: "abstract.finalized",
      clientId: existing.event.clientId,
      eventId,
      payload: {
        id: updated.id,
        status: updated.status,
        code: updated.code,
        averageScore: updated.averageScore,
        reviewCount: updated.reviewCount,
      },
      ts: Date.now(),
    });

    return updated;
  });

  return getAdminAbstract(eventId, abstractId);
}

export async function reopenAbstract(
  eventId: string,
  abstractId: string,
  performedBy: string,
) {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.abstract.findUnique({
      where: { id: abstractId },
      include: {
        event: { select: { clientId: true } },
        reviews: { where: { active: true }, select: { id: true } },
      },
    });

    if (!existing || existing.eventId !== eventId) {
      throw new AppError("Abstract not found", 404, ErrorCodes.NOT_FOUND);
    }
    if (!FINAL_STATUSES.includes(existing.status)) {
      throw new AppError("Only finalized abstracts can be reopened", 409, ErrorCodes.INVALID_STATUS_TRANSITION);
    }

    const nextStatus = existing.reviews.length > 0
      ? AbstractStatus.UNDER_REVIEW
      : AbstractStatus.SUBMITTED;

    const updated = await tx.abstract.update({
      where: { id: abstractId },
      data: {
        status: nextStatus,
        finalType: null,
        code: null,
        codeNumber: null,
      },
      select: { id: true, status: true, averageScore: true, reviewCount: true },
    });

    await auditLog(tx, {
      entityType: "Abstract",
      entityId: abstractId,
      action: "reopen",
      changes: {
        status: { old: existing.status, new: nextStatus },
        finalType: { old: existing.finalType, new: null },
        code: { old: existing.code, new: null },
      },
      performedBy,
    });

    await enqueueRealtimeOutboxEvent(tx, {
      type: "abstract.reopened",
      clientId: existing.event.clientId,
      eventId,
      payload: {
        id: updated.id,
        status: updated.status,
        averageScore: updated.averageScore,
        reviewCount: updated.reviewCount,
      },
      ts: Date.now(),
    });

    return updated;
  });

  return getAdminAbstract(eventId, abstractId);
}

export async function markAbstractPresented(
  eventId: string,
  abstractId: string,
  presented: boolean,
  performedBy: string,
) {
  const existing = await prisma.abstract.findUnique({
    where: { id: abstractId },
    select: {
      id: true,
      eventId: true,
      status: true,
      presentedAt: true,
      event: { select: { clientId: true } },
    },
  });

  if (!existing || existing.eventId !== eventId) {
    throw new AppError("Abstract not found", 404, ErrorCodes.NOT_FOUND);
  }
  if (existing.status !== AbstractStatus.ACCEPTED) {
    throw new AppError(
      "Only accepted abstracts can be marked as presented",
      409,
      ErrorCodes.INVALID_STATUS_TRANSITION,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.abstract.update({
      where: { id: abstractId },
      data: presented
        ? { presentedAt: new Date(), presentedBy: performedBy }
        : { presentedAt: null, presentedBy: null },
    });

    await auditLog(tx, {
      entityType: "Abstract",
      entityId: abstractId,
      action: presented ? "mark_presented" : "unmark_presented",
      changes: {
        presentedAt: { old: existing.presentedAt, new: presented ? "now" : null },
      },
      performedBy,
    });

    await enqueueRealtimeOutboxEvent(tx, {
      type: "abstract.presentationChanged",
      clientId: existing.event.clientId,
      eventId,
      payload: { id: abstractId, presented },
      ts: Date.now(),
    });
  });

  return getAdminAbstract(eventId, abstractId);
}
