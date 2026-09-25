import { Inject, Injectable } from "@nestjs/common";
import {
  findEventClientId,
  findAbstractEmailTemplate,
  type EmailTemplateRow,
} from "@app/db";
import {
  compileMjmlToHtml,
  renderEmailLayout,
  resolveVariables,
  sendEmailNow,
  type SendEmailNowInput,
} from "@app/integrations";
import { escapeHtml } from "@app/shared";
import { CONFIG, type Config } from "../../core/config";
import { logger } from "../../core/logger.service";
const EVENT_NAME_TOKEN = "{eventName}";

/**
 * Committee invitations and password links. Both go through sendEmailNow
 * (3.6b): each one records an email_logs row, and the hardcoded ones use the
 * shared email layout. Each method resolves true only when the provider
 * accepted the email; an UNCERTAIN send (the provider may have taken it)
 * counts as not sent, so a self-service resend keeps the member's current
 * link valid.
 */
@Injectable()
export class CommitteeEmailsService {
  constructor(@Inject(CONFIG) private readonly config: Config) {}
  async sendInviteEmail(
    user: { email: string; name: string },
    eventName: string,
    link: string,
    eventId: string,
  ): Promise<boolean> {
    const event = await findEventClientId(eventId);
    const template = event
      ? await findAbstractEmailTemplate({
          clientId: event.clientId,
          eventId: eventId,
          abstractTrigger: "ABSTRACT_COMMITTEE_INVITE",
        })
      : null;
    if (template) {
      return await this.sendTemplatedCommitteeEmail(
        template,
        user.email,
        user.name,
        {
          reviewerName: user.name,
          eventName,
          loginLink: link,
        },
      );
    }

    return await this.sendCommitteeMjmlEmail({
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
      what: "committee invitation email",
      logAsInvite: true,
    });
  }
  private async sendTemplatedCommitteeEmail(
    template: EmailTemplateRow,
    to: string,
    toName: string,
    variables: Record<string, string>,
  ): Promise<boolean> {
    const subject = resolveVariables(template.subject, variables, { mode: "text" });
    const html = resolveVariables(template.htmlContent ?? "", variables);
    return this.deliver(
      {
        to,
        toName,
        subject,
        html,
        categories: ["committee-invite"],
        log: { abstractTrigger: "ABSTRACT_COMMITTEE_INVITE" },
      },
      "templated committee invitation email",
    );
  }

  /** sendEmailNow → true only when the provider accepted the email. */
  private async deliver(input: SendEmailNowInput, what: string): Promise<boolean> {
    const result = await sendEmailNow(input);
    if (result.status === "SENT") return true;
    if (result.status === "UNCERTAIN") {
      logger.warn(
        { emailLogId: result.emailLogId, error: result.error },
        `The email provider did not confirm the ${what}; it may have been sent`,
      );
    } else {
      logger.error(
        { emailLogId: result.emailLogId, error: result.error },
        `Failed to send the ${what}`,
      );
    }
    return false;
  }

  private async sendCommitteeMjmlEmail(input: {
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
    what: string;
    /** M7: the invitation's row carries ABSTRACT_COMMITTEE_INVITE. */
    logAsInvite?: boolean;
  }): Promise<boolean> {
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
    const footnoteBlock = input.footnote
      ? `<mj-text font-size="13px" color="#6b7280">${escapeHtml(
          input.footnote,
        )}</mj-text>`
      : "";
    const body = `
        <mj-text font-size="20px" font-weight="600">${safeHeadline}</mj-text>
        <mj-text>Bonjour ${safeName},</mj-text>
        <mj-text>${safeIntro}</mj-text>
        <mj-button href="${safeLink}">${safeCtaText}</mj-button>
        <mj-text font-size="13px" color="#6b7280">Ce lien est valable ${this.config.security.committeeInvite.tokenTtlDays} jour(s) et ne peut être utilisé qu'une seule fois. Après avoir défini votre mot de passe, vous pourrez vous connecter directement avec votre email.</mj-text>
        ${footnoteBlock}`;
    const { html } = await compileMjmlToHtml(
      renderEmailLayout(body, { header: safeEventName }),
    );

    return this.deliver(
      {
        to: input.to,
        toName,
        subject: input.subject,
        html,
        categories: [input.category],
        log: input.logAsInvite ? { abstractTrigger: "ABSTRACT_COMMITTEE_INVITE" } : undefined,
      },
      input.what,
    );
  }
  async sendResetPasswordEmail(
    user: { email: string; name: string },
    eventName: string,
    link: string,
  ): Promise<boolean> {
    return this.sendCommitteeMjmlEmail({
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
      what: "committee password-link email",
    });
  }
}
