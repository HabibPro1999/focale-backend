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
import { AppException } from "../../core/app-exception";

const ALREADY_FINALIZED_MSG =
  "Abstract is already finalized; reopen before changing the decision";

function getTitle(content: unknown): string {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const title = (content as { title?: unknown }).title;
    if (typeof title === "string" && title.trim()) return title.trim();
  }
  return "Untitled abstract";
}

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

function reviewScoreSpread(reviews: Array<{ score: number | null }>): {
  min: number | null;
  max: number | null;
  spread: number | null;
} {
  const scores = reviews
    .map((review) => review.score)
    .filter((score): score is number => score !== null);
  if (scores.length < 2) return { min: null, max: null, spread: null };
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  return { min, max, spread: max - min };
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
      throw new AppException(ErrorCodes.NOT_FOUND, "Abstract not found", 404);
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
          throw new AppException(
            ErrorCodes.NOT_FOUND,
            "Abstract not found",
            404,
          );
        case "already_finalized":
          throw new AppException(
            ErrorCodes.INVALID_STATUS_TRANSITION,
            ALREADY_FINALIZED_MSG,
            409,
          );
        case "missing_final_type":
          throw new AppException(
            ErrorCodes.VALIDATION_ERROR,
            "Final presentation type is required when accepting an abstract",
            400,
          );
        case "no_theme":
          throw new AppException(
            ErrorCodes.ABSTRACT_INVALID_THEMES,
            "Accepted abstracts must have a theme before a code can be allocated",
            400,
          );
        case "code_conflict":
          throw new AppException(
            ErrorCodes.CONFLICT,
            "Allocated abstract code collides with an existing one (themes sharing a sort order?) — fix theme sort orders and retry",
            409,
          );
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
        throw new AppException(ErrorCodes.NOT_FOUND, "Abstract not found", 404);
      }
      throw new AppException(
        ErrorCodes.INVALID_STATUS_TRANSITION,
        "Only finalized abstracts can be reopened",
        409,
      );
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
        throw new AppException(ErrorCodes.NOT_FOUND, "Abstract not found", 404);
      }
      throw new AppException(
        ErrorCodes.INVALID_STATUS_TRANSITION,
        "Only accepted abstracts can be marked as presented",
        409,
      );
    }
    return this.getAdminAbstract(eventId, abstractId);
  }
}
