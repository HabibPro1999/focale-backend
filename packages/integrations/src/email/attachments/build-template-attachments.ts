// =============================================================================
// TEMPLATE ATTACHMENTS
// Builds the attachments a template's configuration asks for, at send time
// (the queue, test sends). Deterministic for a given registration, so a
// retried send attaches the same files.
// =============================================================================

import { createLogger } from "@app/shared";
import type { EmailTemplateAttachment } from "@app/contracts";
import type { EmailAttachment } from "../providers/email-provider.types";
import { formatRegistrationNumber } from "../rendering/context";
import { renderRegistrationQrPng } from "./registration-qr";

const logger = createLogger({ name: "email:attachments" });

export interface TemplateAttachmentTarget {
  /** The registration the email is about; null for rows without one (sponsors, abstract authors). */
  registrationId: string | null | undefined;
  /** For the log line of a skipped attachment. */
  emailLogId?: string;
}

/**
 * The attachments for `config`. One that needs a registration is left out,
 * with a warning, when the email has none: the email still goes out.
 */
export async function buildTemplateAttachments(
  config: readonly EmailTemplateAttachment[],
  target: TemplateAttachmentTarget,
): Promise<EmailAttachment[]> {
  const attachments: EmailAttachment[] = [];
  for (const entry of config) {
    switch (entry.type) {
      case "REGISTRATION_QR": {
        const { registrationId } = target;
        if (!registrationId) {
          logger.warn(
            { emailLogId: target.emailLogId, attachment: entry.type },
            "Template attachment skipped: the email has no registration",
          );
          break;
        }
        const png = await renderRegistrationQrPng(registrationId);
        attachments.push({
          filename: `checkin-qr-${formatRegistrationNumber(registrationId)}.png`,
          type: "image/png",
          disposition: "attachment",
          content: png.toString("base64"),
        });
        break;
      }
    }
  }
  return attachments;
}
