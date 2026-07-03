// =============================================================================
// ABSTRACT EMAIL QUEUE
// Consumes `email.abstract` outbox events (worker handler): looks up the
// abstract + event + config, builds the French variable context, finds the
// active template (event-specific → client-wide cascade), and enqueues a
// QUEUED email_logs row via queueEmail.
//
// PORT NOTE (deviation): the legacy queueAbstractEmail also had a plain-text
// FALLBACK path (inline _fallbackPlainBody) when no admin template existed. The
// new processEmailQueue (queue.ts) skips rows with no template and has no
// _fallbackPlainBody rendering, so the fallback is intentionally NOT ported
// here — no template means "not sent" (logged), same as the other queue fns.
// Restore both halves together if fallback abstract emails are needed.
// =============================================================================

import { createLogger } from "@app/shared";
import type { AbstractEmailTrigger } from "@app/contracts";
import {
  getAbstractForEmailContext,
  findAbstractEmailTemplate,
  pgUniqueViolation,
  type AbstractForEmailContext,
  type AbstractEmailOutboxPayload,
} from "@app/db";
import { queueEmail } from "./queue";
import { formatDate } from "./rendering/index";

const logger = createLogger({ name: "email:abstract-queue" });

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

function contentTitle(content: unknown): string {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const title = (content as Record<string, unknown>).title;
    if (typeof title === "string") return title;
  }
  return "";
}

/** Port of legacy buildAbstractEmailContext — the French templating variables. */
function buildAbstractEmailContext(
  abstract: AbstractForEmailContext,
): Record<string, string> {
  const baseUrl = abstract.linkBaseUrl || "https://events.example.com";
  const slug = abstract.event.slug || "";

  const authorName =
    `${abstract.authorFirstName} ${abstract.authorLastName}`.trim();
  const presentationType =
    TYPE_LABELS[abstract.finalType ?? ""] ||
    TYPE_LABELS[abstract.requestedType] ||
    abstract.requestedType;
  const abstractEditLink = `${baseUrl}/${slug}/abstracts/${abstract.id}/${abstract.editToken}`;
  const editingDeadline = formatDate(abstract.config.editingDeadline);

  return {
    authorName,
    submissionTitle: contentTitle(abstract.content),
    submissionStatus: STATUS_LABELS[abstract.status] || abstract.status,
    presentationType,
    submissionCode: abstract.code || "",
    congressName: abstract.event.name,
    platformLink: `${baseUrl}/${slug}`,
    abstractEditLink,
    finalFileUploadLink: abstractEditLink,
    submissionStartAt: formatDate(abstract.config.submissionStartAt),
    submissionDeadline: formatDate(abstract.config.submissionDeadline),
    editingDeadline,
    scoringStartAt: formatDate(abstract.config.scoringStartAt),
    scoringDeadline: formatDate(abstract.config.scoringDeadline),
    finalFileDeadline: formatDate(abstract.config.finalFileDeadline),
    finalFileUploadEnabled: abstract.config.finalFileUploadEnabled ? "Oui" : "Non",
    // Back-compat alias for templates authored before explicit date variables.
    deadlineDate: editingDeadline,
    committeeComments: "",
  };
}

// The partial unique index that enforces one ABSTRACT_SUBMISSION_ACK per
// abstract+recipient. A concurrent enqueue races → 23505 on this constraint,
// which we swallow (idempotent), mirroring the legacy P2002 handling.
const ABSTRACT_ACK_DEDUPE_CONSTRAINT =
  "email_logs_abstract_submission_ack_active_key";

function isAbstractAckDedupe(error: unknown, trigger: string): boolean {
  if (trigger !== "ABSTRACT_SUBMISSION_ACK") return false;
  const v = pgUniqueViolation(error);
  return v !== null && v.constraint.includes(ABSTRACT_ACK_DEDUPE_CONSTRAINT);
}

/**
 * Queue an abstract email. Returns true when a row was enqueued, false when
 * skipped (abstract gone / no template / dedupe race) — parity with the other
 * queue fns' false-on-skip contract. The worker handler maps this to
 * processed/skipped for the outbox result counters.
 */
export async function queueAbstractEmail(
  payload: AbstractEmailOutboxPayload,
): Promise<boolean> {
  const { trigger, abstractId, recipientOverride, extraContext } = payload;

  const abstract = await getAbstractForEmailContext(abstractId);
  if (!abstract) {
    logger.warn({ abstractId, trigger }, "Abstract not found for email queue");
    return false;
  }

  const template = await findAbstractEmailTemplate({
    clientId: abstract.event.clientId,
    eventId: abstract.eventId,
    abstractTrigger: trigger as AbstractEmailTrigger,
  });
  if (!template) {
    logger.warn(
      { trigger, abstractId },
      "No template configured for abstract email trigger — email not sent",
    );
    return false;
  }

  const context = {
    ...buildAbstractEmailContext(abstract),
    ...(extraContext ?? {}),
  };

  try {
    const result = await queueEmail({
      templateId: template.id,
      abstractId,
      abstractTrigger: trigger as AbstractEmailTrigger,
      recipientEmail: recipientOverride?.email ?? abstract.authorEmail,
      recipientName:
        recipientOverride?.name ??
        `${abstract.authorFirstName} ${abstract.authorLastName}`.trim(),
      contextSnapshot: context,
    });
    if (!result.ok) {
      logger.info(
        { trigger, abstractId },
        "Abstract email already queued, skipping duplicate",
      );
      return false;
    }
  } catch (error) {
    if (isAbstractAckDedupe(error, trigger)) {
      logger.info(
        { trigger, abstractId },
        "Abstract email already queued, skipping duplicate",
      );
      return false;
    }
    throw error;
  }

  logger.info(
    { trigger, abstractId, templateId: template.id },
    "Queued abstract email via template",
  );
  return true;
}
