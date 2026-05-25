import type { AbstractEmailTrigger } from "@/generated/prisma/client.js";
import { formatDate } from "@modules/email/email-context.js";

export interface AbstractForEmail {
  id: string;
  authorFirstName: string;
  authorLastName: string;
  authorEmail: string;
  content: { title?: string; mode?: string } & Record<string, unknown>;
  status: string;
  requestedType: string;
  finalType: string | null;
  code: string | null;
  editToken: string;
  linkBaseUrl: string | null;
  event: {
    name: string;
    slug: string;
  };
  config: {
    submissionStartAt: Date | null;
    submissionDeadline: Date | null;
    editingDeadline: Date | null;
    scoringStartAt: Date | null;
    scoringDeadline: Date | null;
    finalFileDeadline: Date | null;
    finalFileUploadEnabled: boolean;
  };
}

const STATUS_LABELS: Record<string, string> = {
  SUBMITTED: "Soumis",
  UNDER_REVIEW: "En cours d'évaluation",
  REVIEW_COMPLETE: "Évaluation terminée",
  ACCEPTED: "Accepté",
  REJECTED: "Refusé",
  PENDING: "En attente",
};

const TYPE_LABELS: Record<string, string> = {
  CONFERENCE: "Conférence",
  ORAL_COMMUNICATION: "Communication orale",
  POSTER: "Communication affichée",
};

export function buildAbstractEmailContext(
  abstract: AbstractForEmail,
  _trigger: AbstractEmailTrigger,
): Record<string, string> {
  const baseUrl = abstract.linkBaseUrl || "https://events.example.com";
  const slug = abstract.event.slug || "";

  const authorName = `${abstract.authorFirstName} ${abstract.authorLastName}`.trim();
  const submissionTitle = abstract.content.title || "";
  const submissionStatus = STATUS_LABELS[abstract.status] || abstract.status;
  const presentationType =
    TYPE_LABELS[abstract.finalType ?? ""] ||
    TYPE_LABELS[abstract.requestedType] ||
    abstract.requestedType;
  const submissionCode = abstract.code || "";
  const congressName = abstract.event.name;
  const platformLink = `${baseUrl}/${slug}`;
  const abstractEditLink = `${baseUrl}/${slug}/abstracts/${abstract.id}/${abstract.editToken}`;
  const finalFileUploadLink = abstractEditLink;

  const submissionStartAt = formatDate(abstract.config.submissionStartAt);
  const submissionDeadline = formatDate(abstract.config.submissionDeadline);
  const editingDeadline = formatDate(abstract.config.editingDeadline);
  const scoringStartAt = formatDate(abstract.config.scoringStartAt);
  const scoringDeadline = formatDate(abstract.config.scoringDeadline);
  const finalFileDeadline = formatDate(abstract.config.finalFileDeadline);

  const committeeComments = ""; // May be overridden by queueAbstractEmail extraContext

  return {
    authorName,
    submissionTitle,
    submissionStatus,
    presentationType,
    submissionCode,
    congressName,
    platformLink,
    abstractEditLink,
    finalFileUploadLink,
    submissionStartAt,
    submissionDeadline,
    editingDeadline,
    scoringStartAt,
    scoringDeadline,
    finalFileDeadline,
    finalFileUploadEnabled: abstract.config.finalFileUploadEnabled ? "Oui" : "Non",
    // Back-compat alias for templates authored before explicit date variables existed.
    deadlineDate: editingDeadline,
    committeeComments,
  };
}
