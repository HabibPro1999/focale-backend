// =============================================================================
// ABSTRACT EMAIL QUEUE
// Consumes `email.abstract` outbox events (worker handler): looks up the
// abstract + event + config, builds the French variable context, finds the
// active template (event-specific → client-wide cascade), and enqueues a
// QUEUED email_logs row via queueEmail.
//
// C1/N4 fix: when no admin template is configured, this falls back to a
// plain-text subject/body (FALLBACK_SUBJECTS/FALLBACK_BODIES below, ported
// from the legacy queueAbstractEmail) instead of silently dropping the email.
// Unlike the legacy version — which stashed the fallback body under a
// templateId-less row that the send worker then marked terminally SKIPPED —
// the fallback here rides the SAME resolution path as a real template
// (queue.ts's processEmail detects the `_fallbackSubject`/`_fallbackPlainBody`
// markers) and gets ACTUALLY SENT. A trigger with no fallback text at all
// (there is none for ABSTRACT_COMMITTEE_INVITE, which never reaches this
// queue — see abstracts.committee.service.ts) is a genuine unbuildable-context
// failure and throws, so the outbox reports it as "failed" (retried, then
// dead-lettered) rather than a silent "skipped".
// =============================================================================

import { createLogger } from "@app/shared";
import type { AbstractEmailTrigger } from "@app/contracts";
import {
  getAbstractForEmailContext,
  findAbstractEmailTemplate,
  pgUniqueViolation,
  EMAIL_LOGS_DEDUPE_KEY_ACTIVE_KEY,
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

// -----------------------------------------------------------------------------
// Plain-text fallback templates (C1/N4), used when no admin template is
// configured. Ported from the legacy queueAbstractEmail. {{var}} placeholders
// are resolved at send time (queue.ts) against the same context this module
// builds below — deliberately NOT resolved here, so the same resolveVariables
// call (and its HTML-escaping) applies uniformly to templates and fallbacks.
// ABSTRACT_COMMITTEE_INVITE has none on purpose: it never reaches this queue
// (sent via a hand-built MJML path in abstracts.committee.service.ts).
// -----------------------------------------------------------------------------
const FALLBACK_SUBJECTS: Partial<Record<AbstractEmailTrigger, string>> = {
  ABSTRACT_SUBMISSION_ACK: "Votre abstract a été soumis — {{congressName}}",
  ABSTRACT_EDIT_ACK: "Votre abstract a été mis à jour — {{congressName}}",
  ABSTRACT_DECISION: "Décision abstract — {{congressName}}",
  ABSTRACT_ACCEPTED: "Abstract accepté — {{congressName}}",
  ABSTRACT_REJECTED: "Abstract refusé — {{congressName}}",
  ABSTRACT_COMMITTEE_COMMENTS: "Commentaires du comité — {{congressName}}",
  ABSTRACT_SCORE_DIVERGENCE: "Alerte d'écart de scores — {{congressName}}",
  ABSTRACT_FINAL_FILE_REQUEST: "Fichier final demandé — {{congressName}}",
};

const FALLBACK_BODIES: Partial<Record<AbstractEmailTrigger, string>> = {
  ABSTRACT_SUBMISSION_ACK: [
    "Bonjour {{authorName}},",
    "",
    'Votre abstract "{{submissionTitle}}" a bien été soumis pour {{congressName}}.',
    "",
    "Vous pouvez consulter ou modifier votre soumission avec ce lien :",
    "{{abstractEditLink}}",
    "",
    "Merci.",
  ].join("\n"),
  ABSTRACT_EDIT_ACK: [
    "Bonjour {{authorName}},",
    "",
    'Votre abstract "{{submissionTitle}}" a été mis à jour.',
    "",
    "Vous pouvez continuer à consulter ou modifier votre soumission ici :",
    "{{abstractEditLink}}",
    "",
    "Merci.",
  ].join("\n"),
  ABSTRACT_DECISION: [
    "Bonjour {{authorName}},",
    "",
    'Une décision a été prise pour votre abstract "{{submissionTitle}}".',
    "Statut : {{submissionStatus}}",
    "Type de communication : {{presentationType}}",
    "Code : {{submissionCode}}",
    "",
    "Vous pouvez consulter votre soumission ici :",
    "{{abstractEditLink}}",
    "",
    "Merci.",
  ].join("\n"),
  ABSTRACT_ACCEPTED: [
    "Bonjour {{authorName}},",
    "",
    'Votre abstract "{{submissionTitle}}" est accepté pour {{congressName}}.',
    "Type de communication : {{presentationType}}",
    "Code : {{submissionCode}}",
    "",
    "Si un fichier final est demandé, merci de le téléverser depuis ce lien :",
    "{{finalFileUploadLink}}",
    "",
    "Merci.",
  ].join("\n"),
  ABSTRACT_REJECTED: [
    "Bonjour {{authorName}},",
    "",
    "Votre abstract \"{{submissionTitle}}\" n'a pas été retenu pour {{congressName}}.",
    "Statut : {{submissionStatus}}",
    "",
    "Vous pouvez consulter votre soumission ici :",
    "{{abstractEditLink}}",
    "",
    "Merci.",
  ].join("\n"),
  ABSTRACT_COMMITTEE_COMMENTS: [
    "Bonjour {{authorName}},",
    "",
    'Le comité a laissé des commentaires pour votre abstract "{{submissionTitle}}" :',
    "",
    "{{committeeComments}}",
    "",
    "Vous pouvez consulter votre soumission ici :",
    "{{abstractEditLink}}",
    "",
    "Merci.",
  ].join("\n"),
  ABSTRACT_SCORE_DIVERGENCE: [
    "Alerte d'écart de scores pour l'abstract {{submissionTitle}}.",
    "",
    "Statut : {{submissionStatus}}",
    "Score moyen : {{averageScore}}",
    "Nombre d'évaluations : {{reviewCount}}",
    "",
    "Merci de consulter l'abstract dans le portail admin.",
  ].join("\n"),
  ABSTRACT_FINAL_FILE_REQUEST: [
    "Bonjour {{authorName}},",
    "",
    'Votre abstract "{{submissionTitle}}" a été accepté.',
    "Merci de téléverser votre fichier final avant la date limite : {{finalFileDeadline}}",
    "",
    "Lien de téléversement :",
    "{{finalFileUploadLink}}",
    "",
    "Merci.",
  ].join("\n"),
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
 * Queue an abstract email. Returns true when a row was enqueued (or an
 * already-processed idempotent redelivery, H6), false when skipped (abstract
 * gone / dedupe race) — parity with the other queue fns' false-on-skip
 * contract. The worker handler maps this to processed/skipped for the outbox
 * result counters. Throws for a genuinely unbuildable context (e.g. a trigger
 * with neither a template nor fallback text) so the outbox surfaces it as a
 * loud "failed" (retried, then dead-lettered) rather than a silent skip.
 *
 * @param dedupeKey H6: per-outbox-delivery idempotency key (the outbox event's
 *   own id, or — for the requeue-skipped-abstract-emails recovery script — a
 *   key derived from the original email_logs id). Stamped on the email_logs
 *   row; a redelivery of the SAME key conflicts on the partial unique index
 *   instead of inserting a duplicate row, and is treated as an idempotent
 *   success (no re-send needed — it already went out).
 */
export async function queueAbstractEmail(
  payload: AbstractEmailOutboxPayload,
  dedupeKey?: string,
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

  let contextSnapshot: Record<string, unknown> = {
    ...buildAbstractEmailContext(abstract),
    ...(extraContext ?? {}),
  };

  if (!template) {
    const fallbackSubject = FALLBACK_SUBJECTS[trigger as AbstractEmailTrigger];
    const fallbackBody = FALLBACK_BODIES[trigger as AbstractEmailTrigger];
    if (!fallbackSubject || !fallbackBody) {
      // Genuinely unbuildable: no admin template AND no fallback text for this
      // trigger. Loud failure (outbox retries, then dead-letters) rather than
      // the silent "skipped" this finding was filed against.
      throw new Error(
        `No template or fallback for abstract email trigger: ${trigger}`,
      );
    }
    logger.info(
      { trigger, abstractId },
      "No template configured for abstract email trigger — using plain-text fallback",
    );
    contextSnapshot = {
      ...contextSnapshot,
      _fallbackSubject: fallbackSubject,
      _fallbackPlainBody: fallbackBody,
    };
  }

  try {
    const result = await queueEmail({
      templateId: template?.id,
      abstractId,
      abstractTrigger: trigger as AbstractEmailTrigger,
      recipientEmail: recipientOverride?.email ?? abstract.authorEmail,
      recipientName:
        recipientOverride?.name ??
        `${abstract.authorFirstName} ${abstract.authorLastName}`.trim(),
      contextSnapshot,
      dedupeKey,
    });
    if (!result.ok) {
      if (result.conflictIndex === EMAIL_LOGS_DEDUPE_KEY_ACTIVE_KEY) {
        // H6: this exact outbox delivery already produced a row — idempotent
        // success, not a skip (nothing new to send, but nothing was dropped).
        logger.info(
          { trigger, abstractId },
          "Abstract email already sent for this delivery, skipping duplicate insert",
        );
        return true;
      }
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
    { trigger, abstractId, templateId: template?.id ?? null },
    template ? "Queued abstract email via template" : "Queued abstract email via fallback",
  );
  return true;
}
