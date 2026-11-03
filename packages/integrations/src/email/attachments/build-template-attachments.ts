// =============================================================================
// TEMPLATE ATTACHMENTS
// Builds the attachments a template's configuration asks for, at send time
// (the queue, test sends). Deterministic for a given registration and
// context, so a retried send attaches the same files.
// =============================================================================

import { createLogger } from "@app/shared";
import type { EmailTemplateAttachment } from "@app/contracts";
import { getBadgeTemplate } from "@app/db";
import type { EmailAttachment } from "../providers/email-provider.types";
import { formatRegistrationNumber } from "../rendering/context";
import { badgeValuesFromContext, generateBadgePdf } from "../../badges/badge-pdf";
import { renderRegistrationQrPng } from "./registration-qr";

const logger = createLogger({ name: "email:attachments" });

export interface TemplateAttachmentTarget {
  /** The registration the email is about; null for rows without one (sponsors, abstract authors). */
  registrationId: string | null | undefined;
  /** The template's event: a badge from another event is never attached. */
  eventId: string | null | undefined;
  /** The email's context (EmailContext, or a queued snapshot): the badge's text zones read it, as the email body does. */
  context: object;
  /** For the log line of a skipped attachment. */
  emailLogId?: string;
}

/**
 * The attachments for `config`. One that cannot be built is left out, with a
 * warning, and the email still goes out: the email has no registration, or
 * its badge template is deleted or belongs to another event.
 */
export async function buildTemplateAttachments(
  config: readonly EmailTemplateAttachment[],
  target: TemplateAttachmentTarget,
): Promise<EmailAttachment[]> {
  const attachments: EmailAttachment[] = [];
  for (const entry of config) {
    const { registrationId } = target;
    if (!registrationId) {
      logger.warn(
        { emailLogId: target.emailLogId, attachment: entry.type },
        "Template attachment skipped: the email has no registration",
      );
      continue;
    }
    const registrationNumber = formatRegistrationNumber(registrationId);
    switch (entry.type) {
      case "REGISTRATION_QR": {
        const png = await renderRegistrationQrPng(registrationId);
        attachments.push({
          filename: `checkin-qr-${registrationNumber}.png`,
          type: "image/png",
          disposition: "attachment",
          content: png.toString("base64"),
        });
        break;
      }
      case "REGISTRATION_BADGE": {
        const badge = await getBadgeTemplate(entry.badgeTemplateId);
        if (!badge || badge.eventId !== target.eventId) {
          logger.warn(
            { emailLogId: target.emailLogId, attachment: entry.type, badgeTemplateId: entry.badgeTemplateId },
            "Template attachment skipped: the badge template is deleted or not the event's",
          );
          break;
        }
        const pdf = await generateBadgePdf(badge, badgeValuesFromContext(target.context), registrationId);
        attachments.push({
          filename: `badge-${registrationNumber}.pdf`,
          type: "application/pdf",
          disposition: "attachment",
          content: pdf.toString("base64"),
        });
        break;
      }
    }
  }
  return attachments;
}
