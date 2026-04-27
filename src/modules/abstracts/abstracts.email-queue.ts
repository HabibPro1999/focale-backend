import { prisma } from "@/database/client.js";
import { logger } from "@shared/utils/logger.js";
import { queueEmail } from "@modules/email/email-queue.service.js";
import {
  buildAbstractEmailContext,
  type AbstractForEmail,
} from "./abstracts.email-context.js";
import type { AbstractEmailTrigger } from "@/generated/prisma/client.js";

// Plain-text fallback templates used when no admin template exists yet.
const FALLBACK_SUBJECTS: Record<string, string> = {
  ABSTRACT_SUBMISSION_ACK:
    "Your abstract has been submitted — {{congressName}}",
  ABSTRACT_EDIT_ACK: "Your abstract has been updated — {{congressName}}",
  ABSTRACT_DECISION: "Abstract decision — {{congressName}}",
  ABSTRACT_COMMITTEE_COMMENTS: "Committee comments — {{congressName}}",
  ABSTRACT_SCORE_DIVERGENCE: "Score divergence alert — {{congressName}}",
  ABSTRACT_FINAL_FILE_REQUEST: "Final file requested — {{congressName}}",
};

const FALLBACK_BODIES: Record<string, string> = {
  ABSTRACT_SUBMISSION_ACK: [
    "Dear {{authorName}},",
    "",
    'Your abstract "{{submissionTitle}}" has been successfully submitted to {{congressName}}.',
    "",
    "You can view or edit your submission using this link:",
    "{{abstractEditLink}}",
    "",
    "Thank you.",
  ].join("\n"),
  ABSTRACT_EDIT_ACK: [
    "Dear {{authorName}},",
    "",
    'Your abstract "{{submissionTitle}}" has been updated.',
    "",
    "You can continue to view or edit your submission here:",
    "{{abstractEditLink}}",
    "",
    "Thank you.",
  ].join("\n"),
};

FALLBACK_BODIES.ABSTRACT_DECISION = [
  "Dear {{authorName}},",
  "",
  'A decision has been made for your abstract "{{submissionTitle}}".',
  "Status: {{submissionStatus}}",
  "Presentation type: {{presentationType}}",
  "Code: {{submissionCode}}",
  "",
  "You can view your submission here:",
  "{{abstractEditLink}}",
  "",
  "Thank you.",
].join("\n");

FALLBACK_BODIES.ABSTRACT_COMMITTEE_COMMENTS = [
  "Dear {{authorName}},",
  "",
  'The committee left comments for your abstract "{{submissionTitle}}":',
  "",
  "{{committeeComments}}",
  "",
  "You can view your submission here:",
  "{{abstractEditLink}}",
  "",
  "Thank you.",
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
  "Dear {{authorName}},",
  "",
  'Your abstract "{{submissionTitle}}" has been accepted.',
  "Please upload your final file before the deadline: {{finalFileDeadline}}",
  "",
  "Upload link:",
  "{{abstractEditLink}}",
  "",
  "Thank you.",
].join("\n");

function resolveVars(
  template: string,
  ctx: Record<string, unknown>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key) => {
    const value = ctx[key];
    return value === null || value === undefined ? "" : String(value);
  });
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
    select: { editingDeadline: true, finalFileDeadline: true },
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
      editingDeadline: config?.editingDeadline ?? null,
      finalFileDeadline: config?.finalFileDeadline ?? null,
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

  logger.info(
    { trigger, abstractId },
    "Queued abstract email via fallback (no template configured)",
  );
}
