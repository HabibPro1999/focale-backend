import type { AbstractEmailTrigger } from "@/generated/prisma/client.js";

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
    editingDeadline: Date | null;
    finalFileDeadline: Date | null;
  };
}

const STATUS_LABELS: Record<string, string> = {
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under Review",
  REVIEW_COMPLETE: "Review Complete",
  ACCEPTED: "Accepted",
  REJECTED: "Rejected",
  PENDING: "Pending",
};

const TYPE_LABELS: Record<string, string> = {
  ORAL_COMMUNICATION: "Oral Communication",
  POSTER: "Poster",
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
  const deadlineDate = abstract.config.editingDeadline
    ? abstract.config.editingDeadline.toISOString()
    : "";
  const finalFileDeadline = abstract.config.finalFileDeadline
    ? abstract.config.finalFileDeadline.toISOString()
    : "";
  const committeeComments = ""; // May be overridden by queueAbstractEmail extraContext

  return {
    authorName,
    author_name: authorName,
    submissionTitle,
    submission_title: submissionTitle,
    submissionStatus,
    submission_status: submissionStatus,
    presentationType,
    presentation_type: presentationType,
    submissionCode,
    submission_code: submissionCode,
    congressName,
    congress_name: congressName,
    platformLink,
    platform_link: platformLink,
    abstractEditLink,
    abstract_edit_link: abstractEditLink,
    deadlineDate,
    deadline_date: deadlineDate,
    finalFileDeadline,
    final_file_deadline: finalFileDeadline,
    committeeComments,
    committee_comments: committeeComments,
  };
}
