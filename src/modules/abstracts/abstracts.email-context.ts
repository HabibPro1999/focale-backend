import type { AbstractEmailTrigger } from "@/generated/prisma/client.js";
import { formatDate } from "@modules/email/email-context.js";
import {
  ABSTRACT_STATUS_LABELS_FR,
  ABSTRACT_TYPE_LABELS_FR,
} from "./abstracts.constants.js";

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

export interface AbstractForBulkEmail extends AbstractForEmail {
  authorPhone: string;
  authorAffiliation: string | null;
  event: AbstractForEmail["event"] & {
    startDate: Date;
    endDate: Date;
    location: string | null;
    client: { name: string; email: string | null; phone: string | null };
  };
}

const STATUS_LABELS = ABSTRACT_STATUS_LABELS_FR as Record<string, string>;
const TYPE_LABELS = ABSTRACT_TYPE_LABELS_FR as Record<string, string>;

export function buildAbstractEmailContext(
  abstract: AbstractForEmail,
  _trigger?: AbstractEmailTrigger,
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

// Adds the base registrant variable ids so MANUAL templates ("Bonjour {{firstName}}") render for abstract authors.
export function buildAbstractBulkEmailContext(
  abstract: AbstractForBulkEmail,
): Record<string, string> {
  const context = buildAbstractEmailContext(abstract);

  return {
    ...context,
    firstName: abstract.authorFirstName,
    lastName: abstract.authorLastName,
    fullName: context.authorName,
    email: abstract.authorEmail,
    phone: abstract.authorPhone,
    authorAffiliation: abstract.authorAffiliation ?? "",
    eventName: abstract.event.name,
    eventDate: formatDate(abstract.event.startDate),
    eventEndDate: formatDate(abstract.event.endDate),
    eventLocation: abstract.event.location ?? "",
    organizerName: abstract.event.client.name,
    organizerEmail: abstract.event.client.email ?? "",
    organizerPhone: abstract.event.client.phone ?? "",
  };
}
