import type { User } from "@/generated/prisma/client.js";
import {
  compileMjmlToHtml,
  escapeHtml,
} from "@modules/email/email-renderer.service.js";
import { sendEmail } from "@modules/email/email-sender.service.js";
import { config } from "@config/app.config.js";
import { logger } from "@shared/utils/logger.js";

/**
 * Committee transactional emails live here (rather than in
 * abstracts.committee.service.ts) so the invite-token service can send them
 * without importing the committee service — which would close an import cycle.
 */

const EVENT_NAME_TOKEN = "{eventName}";

interface SendCommitteeMjmlEmailInput {
  to: string;
  toName?: string | null;
  subject: string;
  headline: string;
  intro: string;
  ctaText: string;
  link: string;
  eventName: string;
  category: string;
  footnote?: string;
  logContext: string;
}

/**
 * Shared MJML + SendGrid plumbing for committee transactional emails.
 *
 * All user-controlled strings are HTML-escaped before being interpolated into
 * the MJML template, since MJML treats text as raw markup.
 */
async function sendCommitteeMjmlEmail(
  input: SendCommitteeMjmlEmailInput,
): Promise<boolean> {
  const toName = input.toName?.trim() || input.to;
  const safeName = escapeHtml(toName);
  const safeEventName = escapeHtml(input.eventName);
  const safeLink = escapeHtml(input.link);
  const safeHeadline = escapeHtml(input.headline);
  const safeCtaText = escapeHtml(input.ctaText);
  const safeIntro = escapeHtml(input.intro).replaceAll(
    EVENT_NAME_TOKEN,
    `<strong>${safeEventName}</strong>`,
  );
  // The intro is composed by the caller — it intentionally allows the
  // {eventName} placeholder to render as bold-wrapped, escaped event name.
  // Caller-provided literal text is otherwise already plain English/French.
  const footnoteBlock = input.footnote
    ? `<mj-text font-size="13px" color="#6b7280">${escapeHtml(
        input.footnote,
      )}</mj-text>`
    : "";
  // Literal French copy — `ttlDays` is a validated positive integer, so no
  // escaping is needed here (unlike the caller-provided strings above).
  const ttlDays = config.security.committeeInvite.tokenTtlDays;
  const validityNotice = `Ce lien est valable ${ttlDays} jour(s) et ne peut être utilisé qu'une seule fois. Après avoir défini votre mot de passe, vous pourrez vous connecter directement avec votre email.`;
  const mjml = `
<mjml>
  <mj-head>
    <mj-attributes>
      <mj-all font-family="Helvetica, Arial, sans-serif" />
      <mj-text font-size="15px" line-height="1.6" color="#1f2937" />
    </mj-attributes>
  </mj-head>
  <mj-body background-color="#fafaf9">
    <mj-section padding="32px 24px">
      <mj-column>
        <mj-text font-size="20px" font-weight="600">${safeHeadline}</mj-text>
        <mj-text>Bonjour ${safeName},</mj-text>
        <mj-text>${safeIntro}</mj-text>
        <mj-button background-color="#0d9488" color="#ffffff" border-radius="6px" href="${safeLink}">${safeCtaText}</mj-button>
        <mj-text font-size="13px" color="#6b7280">${validityNotice}</mj-text>
        ${footnoteBlock}
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;
  const { html } = compileMjmlToHtml(mjml);
  const result = await sendEmail({
    to: input.to,
    toName,
    subject: input.subject,
    html,
    categories: [input.category],
  });
  if (!result.success) {
    logger.error({ email: input.to, error: result.error }, input.logContext);
  }
  return result.success;
}

export async function sendInviteEmail(
  user: Pick<User, "email" | "name">,
  eventName: string,
  link: string,
): Promise<boolean> {
  return sendCommitteeMjmlEmail({
    to: user.email,
    toName: user.name,
    subject: `Invitation au comité scientifique - ${eventName}`,
    headline: "Bienvenue au comité scientifique",
    intro:
      "Vous êtes invité(e) à rejoindre le comité scientifique de {eventName} sur Focale. Pour activer votre compte, choisissez un mot de passe avec le lien sécurisé ci-dessous :",
    ctaText: "Définir mon mot de passe",
    link,
    eventName,
    category: "committee-invite",
    footnote:
      "Si vous n'attendiez pas cette invitation, vous pouvez ignorer cet email.",
    logContext: "Failed to send committee invitation email",
  });
}

export async function sendResetPasswordEmail(
  user: Pick<User, "email" | "name">,
  eventName: string,
  link: string,
): Promise<boolean> {
  return sendCommitteeMjmlEmail({
    to: user.email,
    toName: user.name,
    // Copy is invite-framed on purpose: the link lands on the same
    // "set your password" page as the original invitation, so promising a
    // "reset" (or telling the member to ignore the email) would misdescribe it.
    subject: "Nouveau lien d'accès - comité scientifique",
    headline: "Définir votre mot de passe",
    intro:
      "Un nouveau lien sécurisé a été généré pour votre compte comité scientifique sur {eventName}. Utilisez le bouton ci-dessous pour définir votre mot de passe :",
    ctaText: "Définir mon mot de passe",
    link,
    eventName,
    category: "committee-password-reset",
    footnote:
      "Si vous n'attendiez pas cet email, contactez l'organisateur de l'événement.",
    logContext: "Failed to send committee password-reset email",
  });
}
