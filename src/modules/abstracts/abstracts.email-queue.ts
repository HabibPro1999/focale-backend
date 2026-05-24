import { prisma } from "@/database/client.js";
import { logger } from "@shared/utils/logger.js";
import { queueEmail } from "@modules/email/email-queue.service.js";
import {
  buildAbstractEmailContext,
  type AbstractForEmail,
} from "./abstracts.email-context.js";
import { Prisma, type AbstractEmailTrigger } from "@/generated/prisma/client.js";
import { getPrismaUniqueTarget } from "@shared/errors/prisma-error.js";

// Plain-text fallback templates used when no admin template exists yet.
const FALLBACK_SUBJECTS: Record<string, string> = {
  ABSTRACT_SUBMISSION_ACK:
    "Votre abstract a été soumis — {{congressName}}",
  ABSTRACT_EDIT_ACK: "Votre abstract a été mis à jour — {{congressName}}",
  ABSTRACT_DECISION: "Décision abstract — {{congressName}}",
  ABSTRACT_ACCEPTED: "Abstract accepté — {{congressName}}",
  ABSTRACT_REJECTED: "Abstract refusé — {{congressName}}",
  ABSTRACT_COMMITTEE_COMMENTS: "Commentaires du comité — {{congressName}}",
  ABSTRACT_SCORE_DIVERGENCE: "Alerte d'écart de scores — {{congressName}}",
  ABSTRACT_FINAL_FILE_REQUEST: "Fichier final demandé — {{congressName}}",
};

const FALLBACK_BODIES: Record<string, string> = {
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
};

FALLBACK_BODIES.ABSTRACT_DECISION = [
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
].join("\n");

FALLBACK_BODIES.ABSTRACT_ACCEPTED = [
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
].join("\n");

FALLBACK_BODIES.ABSTRACT_REJECTED = [
  "Bonjour {{authorName}},",
  "",
  "Votre abstract \"{{submissionTitle}}\" n'a pas été retenu pour {{congressName}}.",
  "Statut : {{submissionStatus}}",
  "",
  "Vous pouvez consulter votre soumission ici :",
  "{{abstractEditLink}}",
  "",
  "Merci.",
].join("\n");

FALLBACK_BODIES.ABSTRACT_COMMITTEE_COMMENTS = [
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
].join("\n");

FALLBACK_BODIES.ABSTRACT_SCORE_DIVERGENCE = [
  "Score divergence detected for abstract {{submissionTitle}}.",
  "",
  "Status: {{submissionStatus}}",
  "Average score: {{averageScore}}",
  "Review count: {{reviewCount}}",
  "",
  "Please review the abstract in the admin portal.",
].join("\n");

FALLBACK_BODIES.ABSTRACT_FINAL_FILE_REQUEST = [
  "Bonjour {{authorName}},",
  "",
  'Votre abstract "{{submissionTitle}}" a été accepté.',
  "Merci de téléverser votre fichier final avant la date limite : {{finalFileDeadline}}",
  "",
  "Lien de téléversement :",
  "{{finalFileUploadLink}}",
  "",
  "Merci.",
].join("\n");

function resolveVars(template: string, ctx: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key) => {
    const value = ctx[key];
    return value === null || value === undefined ? "" : String(value);
  });
}

function isAbstractSubmissionAckDedupeViolation(
  error: unknown,
  trigger: AbstractEmailTrigger,
): boolean {
  if (
    trigger !== "ABSTRACT_SUBMISSION_ACK" ||
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }

  const { fields, names } = getPrismaUniqueTarget(error);
  const hasAbstractId = fields.some(
    (field) => field === "abstractId" || field === "abstract_id",
  );
  const hasAbstractTrigger = fields.some(
    (field) => field === "abstractTrigger" || field === "abstract_trigger",
  );
  const hasRecipientEmail = fields.some(
    (field) => field === "recipientEmail" || field === "recipient_email",
  );

  return (
    (hasAbstractId && hasAbstractTrigger && hasRecipientEmail) ||
    names.some((name) =>
      name.includes("email_logs_abstract_submission_ack_active_key"),
    )
  );
}

/**
 * Queue an abstract-related email.
 * Looks up the template by (clientId, abstractTrigger, eventId).
 * Falls back to a plain-text default if no template exists (Phase II).
 */
export async function queueAbstractEmail(input: {
  trigger: AbstractEmailTrigger;
  abstractId: string;
  recipientOverride?: { email: string; name?: string | null };
  extraContext?: Record<string, string | number | null | undefined>;
}): Promise<void> {
  const { trigger, abstractId, recipientOverride, extraContext } = input;

  const abstract = await prisma.abstract.findUnique({
    where: { id: abstractId },
    include: {
      event: {
        select: {
          id: true,
          name: true,
          slug: true,
          clientId: true,
        },
      },
    },
  });

  if (!abstract) {
    logger.warn({ abstractId, trigger }, "Abstract not found for email queue");
    return;
  }

  const config = await prisma.abstractConfig.findUnique({
    where: { eventId: abstract.eventId },
    select: {
      submissionStartAt: true,
      submissionDeadline: true,
      editingDeadline: true,
      scoringStartAt: true,
      scoringDeadline: true,
      finalFileDeadline: true,
      finalFileUploadEnabled: true,
    },
  });

  const emailAbstract: AbstractForEmail = {
    id: abstract.id,
    authorFirstName: abstract.authorFirstName,
    authorLastName: abstract.authorLastName,
    authorEmail: abstract.authorEmail,
    content: abstract.content as AbstractForEmail["content"],
    status: abstract.status,
    requestedType: abstract.requestedType,
    finalType: abstract.finalType,
    code: abstract.code,
    editToken: abstract.editToken,
    linkBaseUrl: abstract.linkBaseUrl,
    event: { name: abstract.event.name, slug: abstract.event.slug },
    config: {
      submissionStartAt: config?.submissionStartAt ?? null,
      submissionDeadline: config?.submissionDeadline ?? null,
      editingDeadline: config?.editingDeadline ?? null,
      scoringStartAt: config?.scoringStartAt ?? null,
      scoringDeadline: config?.scoringDeadline ?? null,
      finalFileDeadline: config?.finalFileDeadline ?? null,
      finalFileUploadEnabled: config?.finalFileUploadEnabled ?? false,
    },
  };

  const context = {
    ...buildAbstractEmailContext(emailAbstract, trigger),
    ...(extraContext ?? {}),
  };

  // Try to find an admin-configured template
  const template = await prisma.emailTemplate.findFirst({
    where: {
      clientId: abstract.event.clientId,
      abstractTrigger: trigger,
      eventId: abstract.eventId,
      isActive: true,
    },
  });

  // Cascade: event-specific → client-wide → fallback
  const clientTemplate =
    template ??
    (await prisma.emailTemplate.findFirst({
      where: {
        clientId: abstract.event.clientId,
        abstractTrigger: trigger,
        eventId: null,
        isActive: true,
      },
    }));

  if (clientTemplate) {
    try {
      await queueEmail({
        templateId: clientTemplate.id,
        recipientEmail: recipientOverride?.email ?? abstract.authorEmail,
        recipientName:
          recipientOverride?.name ??
          `${abstract.authorFirstName} ${abstract.authorLastName}`.trim(),
        contextSnapshot: context,
        abstractId,
        abstractTrigger: trigger,
      });
    } catch (error) {
      if (isAbstractSubmissionAckDedupeViolation(error, trigger)) {
        logger.info(
          { trigger, abstractId },
          "Abstract email already queued, skipping duplicate",
        );
        return;
      }
      throw error;
    }

    logger.info(
      { trigger, abstractId, templateId: clientTemplate.id },
      "Queued abstract email via template",
    );
    return;
  }

  // Fallback: direct queue with inline content
  const fallbackSubject = FALLBACK_SUBJECTS[trigger];
  const fallbackBody = FALLBACK_BODIES[trigger];

  if (!fallbackSubject || !fallbackBody) {
    logger.warn(
      { trigger, abstractId },
      "No template or fallback for abstract email trigger — email not sent",
    );
    return;
  }

  const resolvedSubject = resolveVars(fallbackSubject, context);
  const resolvedBody = resolveVars(fallbackBody, context);

  try {
    await prisma.emailLog.create({
      data: {
        recipientEmail: recipientOverride?.email ?? abstract.authorEmail,
        recipientName:
          recipientOverride?.name ??
          `${abstract.authorFirstName} ${abstract.authorLastName}`.trim(),
        abstractId,
        abstractTrigger: trigger,
        subject: resolvedSubject,
        status: "QUEUED",
        contextSnapshot: {
          ...context,
          _fallbackPlainBody: resolvedBody,
        },
      },
    });
  } catch (error) {
    if (isAbstractSubmissionAckDedupeViolation(error, trigger)) {
      logger.info(
        { trigger, abstractId },
        "Abstract email already queued, skipping duplicate",
      );
      return;
    }
    throw error;
  }

  logger.info(
    { trigger, abstractId },
    "Queued abstract email via fallback (no template configured)",
  );
}
