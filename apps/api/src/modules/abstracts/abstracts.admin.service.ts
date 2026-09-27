import { getAbstractTitle as getTitle, summarizeScores } from "@app/shared";
export { getAbstractTitle as getTitle } from "@app/shared";
import { Injectable } from "@nestjs/common";
import {
  ErrorCodes,
  type ListAbstractsQuery,
  type FinalizeAbstractInput,
} from "@app/contracts";
import {
  listAdminAbstracts,
  getAdminAbstractDetail,
  finalizeAbstractTxn,
  reopenAbstractTxn,
  markAbstractPresentedTxn,
  type AdminAbstractRow,
  type AdminReviewRow,
} from "@app/db";
import { getStorageProvider } from "@app/integrations";
import { notFound, conflict, badRequest } from "../../core/app-exception";

const ALREADY_FINALIZED_MSG =
  "Abstract is already finalized; reopen before changing the decision";

function toReviewDto(review: AdminReviewRow) {
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

export function reviewScoreSpread(reviews: Array<{ score: number | null }>): {
  min: number | null;
  max: number | null;
  spread: number | null;
} {
  const scores = reviews
    .map((review) => review.score)
    .filter((score): score is number => score !== null);
  const { min, max, spread } = summarizeScores(scores);
  return { min, max, spread };
}

function formatAdminAbstract(abstract: AdminAbstractRow) {
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
    authorAffiliation: abstract.authorAffiliation,
    authorEmail: abstract.authorEmail,
    authorPhone: abstract.authorPhone,
    averageScore: abstract.reviewCount > 0 ? abstract.averageScore : null,
    reviewCount: abstract.reviewCount,
    themeLabels: abstract.themes.map((theme) => theme.label),
    themeIds: abstract.themes.map((theme) => theme.id),
    reviews: abstract.reviews.map(toReviewDto),
    scoreSpread: reviewScoreSpread(abstract.reviews),
    createdAt: abstract.createdAt.toISOString(),
    updatedAt: abstract.updatedAt.toISOString(),
    lastEditedAt: abstract.lastEditedAt?.toISOString() ?? null,
  };
}

@Injectable()
export class AbstractsAdminService {
  async listAdminAbstracts(eventId: string, query: ListAbstractsQuery = {}) {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const { items, total } = await listAdminAbstracts(eventId, {
      status: query.status,
      themeId: query.themeId,
      reviewerId: query.reviewerId,
      q: query.q,
      presentationType: query.presentationType,
      limit,
      offset,
    });
    return {
      items: items.map(formatAdminAbstract),
      total,
      limit,
      offset,
    };
  }

  async getAdminAbstract(eventId: string, abstractId: string) {
    const abstract = await getAdminAbstractDetail(eventId, abstractId);
    if (!abstract) {
      throw notFound("Abstract not found");
    }

    const finalFileDownloadUrl = abstract.finalFileKey
      ? await getStorageProvider().getSignedUrl(abstract.finalFileKey, 3600)
      : null;

    return {
      ...formatAdminAbstract(abstract),
      content: abstract.content,
      coAuthors: abstract.coAuthors,
      additionalFieldsData: abstract.additionalFieldsData,
      registrationId: abstract.registrationId,
      finalFile: {
        key: abstract.finalFileKey,
        kind: abstract.finalFileKind,
        size: abstract.finalFileSize,
        uploadedAt: abstract.finalFileUploadedAt?.toISOString() ?? null,
        downloadUrl: finalFileDownloadUrl,
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

  // ==========================================================================
  // Decisions — finalize / reopen / presented
  // ==========================================================================
  async finalizeAbstract(
    eventId: string,
    abstractId: string,
    input: FinalizeAbstractInput,
    performedBy: string,
  ) {
    const result = await finalizeAbstractTxn({
      eventId,
      abstractId,
      decision: input.decision,
      finalType: input.finalType,
      performedBy,
    });
    if (!result.ok) {
      switch (result.reason) {
        case "not_found":
          throw notFound("Abstract not found");
        case "already_finalized":
          throw conflict(ALREADY_FINALIZED_MSG, { code: ErrorCodes.INVALID_STATUS_TRANSITION });
        case "missing_final_type":
          throw badRequest("Final presentation type is required when accepting an abstract");
        case "no_theme":
          throw badRequest("Accepted abstracts must have a theme before a code can be allocated", { code: ErrorCodes.ABSTRACT_INVALID_THEMES });
        case "code_conflict":
          throw conflict("Allocated abstract code collides with an existing one (themes sharing a sort order?) — fix theme sort orders and retry");
      }
    }
    // Response reflects post-commit state via a fresh read (matches legacy).
    return this.getAdminAbstract(eventId, abstractId);
  }

  async reopenAbstract(
    eventId: string,
    abstractId: string,
    performedBy: string,
  ) {
    const result = await reopenAbstractTxn({ eventId, abstractId, performedBy });
    if (!result.ok) {
      if (result.reason === "not_found") {
        throw notFound("Abstract not found");
      }
      throw conflict("Only finalized abstracts can be reopened", { code: ErrorCodes.INVALID_STATUS_TRANSITION });
    }
    return this.getAdminAbstract(eventId, abstractId);
  }

  async markAbstractPresented(
    eventId: string,
    abstractId: string,
    presented: boolean,
    performedBy: string,
  ) {
    const result = await markAbstractPresentedTxn({
      eventId,
      abstractId,
      presented,
      performedBy,
    });
    if (!result.ok) {
      if (result.reason === "not_found") {
        throw notFound("Abstract not found");
      }
      throw conflict("Only accepted abstracts can be marked as presented", { code: ErrorCodes.INVALID_STATUS_TRANSITION });
    }
    return this.getAdminAbstract(eventId, abstractId);
  }
}
