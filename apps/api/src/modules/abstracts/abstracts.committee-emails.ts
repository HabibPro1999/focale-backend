import { Inject, Injectable } from "@nestjs/common";
import {
  findEventClientId,
  findAbstractEmailTemplate,
  createEmailLog,
  updateEmailLogById,
  type EmailTemplateRow,
} from "@app/db";
import {
  getEmailProvider,
  compileMjmlToHtml,
  resolveVariables,
} from "@app/integrations";
import { escapeHtml } from "@app/shared";
import { CONFIG, type Config } from "../../core/config";
import { logger } from "../../core/logger.service";
const EVENT_NAME_TOKEN = "{eventName}";
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
      logContext: "Failed to send committee invitation email",
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
    return this.sendAndLogInviteEmail({
      to,
      toName,
      subject,
      html,
      categories: ["committee-invite"],
      logContext: "Failed to send templated committee invite email",
    });
  }

  private async sendAndLogInviteEmail(input: {
    to: string;
    toName?: string | null;
    subject: string;
    html: string;
    categories: string[];
    logContext: string;
  }): Promise<boolean> {
    let emailLogId: string | null = null;
    try {
      const logResult = await createEmailLog({
        trigger: null,
        abstractTrigger: "ABSTRACT_COMMITTEE_INVITE",
        templateId: null,
        registrationId: null,
        abstractId: null,
        recipientEmail: input.to,
        recipientName: input.toName || null,
        subject: input.subject,
        status: "SENDING",
      });
      if (logResult.ok) emailLogId = logResult.log.id;
    } catch (err) {
      logger.error(
        { err, email: input.to },
        "Failed to create committee invite email log",
      );
    }

    let result: { success: boolean; messageId?: string; error?: string };
    try {
      result = await getEmailProvider().sendEmail({
        to: input.to,
        toName: input.toName ?? undefined,
        subject: input.subject,
        html: input.html,
        categories: input.categories,
        trackingId: emailLogId ?? undefined,
      });
    } catch (err) {
      result = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (emailLogId) {
      try {
        await updateEmailLogById(
          emailLogId,
          result.success
            ? {
                status: "SENT",
                providerMessageId: result.messageId,
                sentAt: new Date(),
              }
            : {
                status: "FAILED",
                errorMessage: result.error || "Unknown error",
                failedAt: new Date(),
              },
        );
      } catch (err) {
        logger.error(
          { err, emailLogId },
          "Failed to update committee invite email log",
        );
      }
    }

    if (!result.success) {
      logger.error({ email: input.to, error: result.error }, input.logContext);
    }
    return result.success;
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
    logContext: string;
    /** M7: only the ABSTRACT_COMMITTEE_INVITE fallback records an email_logs row. */
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
        <mj-text font-size="13px" color="#6b7280">Ce lien est valable ${this.config.security.committeeInvite.tokenTtlDays} jour(s) et ne peut être utilisé qu'une seule fois. Après avoir défini votre mot de passe, vous pourrez vous connecter directement avec votre email.</mj-text>
        ${footnoteBlock}
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;
    const { html } = await compileMjmlToHtml(mjml);

    if (input.logAsInvite) {
      return this.sendAndLogInviteEmail({
        to: input.to,
        toName,
        subject: input.subject,
        html,
        categories: [input.category],
        logContext: input.logContext,
      });
    }

    const result = await getEmailProvider().sendEmail({
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
      logContext: "Failed to send committee password-reset email",
    });
  }
}
