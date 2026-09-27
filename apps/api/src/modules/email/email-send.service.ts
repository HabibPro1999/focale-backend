import { Injectable } from "@nestjs/common";
import {
  DEFAULT_LANGUAGE,
  ErrorCodes,
  type BulkSendEmailInput,
  type TiptapDocument,
} from "@app/contracts";
import {
  getRegistrationForEmailContext,
  getRegistrationFormLanguage,
  getRegistrationsByIds,
  getRegistrationsByFilters,
  listSponsorshipBatchesForBulk,
  getClientById,
  insertEmailLogsSkippingConflicts,
  queuedEmailLogValues,
  withTxn,
  type BulkRegistrationRow,
  type EmailTemplateRow,
  type EmailLogInsert,
} from "@app/db";
import {
  getEmailProvider,
  getSampleEmailContext,
  resolveEmailParts,
  buildEmailContextWithAccess,
  buildBatchEmailContext,
  resendUncertainEmail,
  sendEmailNow,
} from "@app/integrations";
import { AppException, conflict, notFound } from "../../core/app-exception";
import { compileTemplateContent } from "./template-content";

/** Minimal event shape the send paths need (subset of EventWithPricing). */
export interface SendEventContext {
  id: string;
  clientId: string;
  name: string;
  startDate: Date;
  location: string | null;
  pricing: { currency: string } | null;
}

@Injectable()
export class EmailSendService {
  // ==========================================================================
  // TEST SEND (synchronous, no EmailLog row)
  // ==========================================================================
  async testSend(
    template: EmailTemplateRow,
    recipientEmail: string,
    recipientName?: string,
  ): Promise<{ success: true; message: string; messageId?: string }> {
    // Sample dates and labels in the event's registration-form language.
    const language = template.eventId
      ? await getRegistrationFormLanguage(template.eventId)
      : DEFAULT_LANGUAGE;
    const sampleContext = getSampleEmailContext(language);

    const resolved = resolveEmailParts(
      {
        subject: template.subject,
        html: template.htmlContent || "",
        plain: template.plainContent || "",
      },
      sampleContext,
    );

    const result = await getEmailProvider().sendEmail({
      to: recipientEmail,
      toName: recipientName,
      subject: `[TEST] ${resolved.subject}`,
      html: resolved.html,
      plainText: resolved.plain,
      categories: ["test-email"],
    });

    if (!result.success) {
      throw new AppException(
        ErrorCodes.INTERNAL_ERROR,
        result.error || "Failed to send test email",
        502,
      );
    }

    return {
      success: true,
      message: `Test email sent to ${recipientEmail}`,
      messageId: result.messageId,
    };
  }

  // ==========================================================================
  // BULK SEND (queues EmailLog rows for the worker to drain)
  // ==========================================================================
  async bulkSend(
    event: SendEventContext,
    templateId: string,
    body: BulkSendEmailInput,
  ): Promise<{ success: true; queued: number; message: string }> {
    const { audience, registrationIds, filters } = body;

    if (audience === "sponsors") {
      return this.bulkSendSponsors(event, templateId);
    }

    let registrations: BulkRegistrationRow[];

    if (registrationIds && registrationIds.length > 0) {
      registrations = await getRegistrationsByIds(event.id, registrationIds);
    } else {
      registrations = await getRegistrationsByFilters(event.id, {
        paymentStatus: filters?.paymentStatus,
        accessTypeIds: filters?.accessTypeIds,
        role: filters?.role,
      });
    }

    if (registrations.length === 0) {
      return {
        success: true,
        queued: 0,
        message: "No recipients matched the criteria",
      };
    }

    const values: EmailLogInsert[] = registrations.map((reg) =>
      queuedEmailLogValues({
        templateId,
        registrationId: reg.id,
        recipientEmail: reg.email,
        recipientName:
          [reg.firstName, reg.lastName].filter(Boolean).join(" ") || null,
      }),
    );
    const queued = (await withTxn((tx) => insertEmailLogsSkippingConflicts(values, tx))).size;

    return {
      success: true,
      queued,
      message: `${queued} emails queued for sending`,
    };
  }

  private async bulkSendSponsors(
    event: SendEventContext,
    templateId: string,
  ): Promise<{ success: true; queued: number; message: string }> {
    const [batches, client] = await Promise.all([
      listSponsorshipBatchesForBulk(event.id),
      getClientById(event.clientId),
    ]);

    // Group by lower-cased email; batches arrive newest-first, so the first-seen
    // entry keeps the newest batch's contact info while later same-email batches
    // append their sponsorships onto it.
    type Batch = (typeof batches)[number];
    const grouped = new Map<
      string,
      { batch: Batch; sponsorships: Batch["sponsorships"] }
    >();
    for (const batch of batches) {
      const key = batch.email.toLowerCase();
      const existing = grouped.get(key);
      if (!existing) {
        grouped.set(key, { batch, sponsorships: [...batch.sponsorships] });
      } else {
        existing.sponsorships.push(...batch.sponsorships);
      }
    }

    const currency = event.pricing?.currency ?? "TND";
    const sponsors = [...grouped.values()]
      .filter(({ sponsorships }) => sponsorships.length > 0)
      .map(({ batch, sponsorships }) => {
        const context = buildBatchEmailContext({
          batch,
          sponsorships,
          event: {
            name: event.name,
            startDate: event.startDate,
            location: event.location,
            client: { name: client?.name ?? "" },
          },
          currency,
        });
        return {
          email: batch.email,
          recipientName: batch.contactName,
          contextSnapshot: context as Record<string, unknown>,
        };
      });

    if (sponsors.length === 0) {
      return {
        success: true,
        queued: 0,
        message: "No sponsors found for this event",
      };
    }

    const valid = sponsors.filter((s) => s.email.trim().length > 0);
    const values: EmailLogInsert[] = valid.map((s) =>
      queuedEmailLogValues({
        templateId,
        recipientEmail: s.email,
        recipientName: s.recipientName || null,
        contextSnapshot: s.contextSnapshot,
      }),
    );
    const queued = (await withTxn((tx) => insertEmailLogsSkippingConflicts(values, tx))).size;

    return {
      success: true,
      queued,
      message: `${queued} emails queued for sending`,
    };
  }

  // ==========================================================================
  // RESEND AN UNCERTAIN EMAIL (3.6; queues a new EmailLog row)
  // ==========================================================================
  async resendUncertain(
    eventId: string,
    emailLogId: string,
  ): Promise<{ id: string; status: "QUEUED"; resentFrom: string }> {
    const result = await resendUncertainEmail(eventId, emailLogId);
    if (result.ok) {
      return { id: result.log.id, status: "QUEUED", resentFrom: emailLogId };
    }
    switch (result.reason) {
      case "not_found":
        throw notFound("Email log not found");
      case "not_uncertain":
        throw conflict("Only an UNCERTAIN email can be resent");
      case "not_resendable":
        throw conflict(
          "This email cannot be resent from its log; send it again from where it was sent",
        );
      case "already_active":
        throw conflict("An active email already covers this one");
    }
  }

  // ==========================================================================
  // SEND CUSTOM ONE-OFF EMAIL (synchronous, through sendEmailNow: the EmailLog
  // row is written first and records the provider's classified outcome)
  // ==========================================================================
  async sendCustom(
    event: SendEventContext,
    registrationId: string,
    subject: string,
    content: TiptapDocument,
  ): Promise<{
    success: true;
    emailLogId: string;
    status: "SENT" | "UNCERTAIN";
    messageId?: string;
  }> {
    const registration = await getRegistrationForEmailContext(registrationId);
    if (!registration || registration.eventId !== event.id) {
      throw new AppException(
        ErrorCodes.REGISTRATION_NOT_FOUND,
        "Registration not found for this event",
        404,
      );
    }

    const context = await buildEmailContextWithAccess(registration);

    const { htmlContent, plainContent } = await compileTemplateContent(content);
    const resolved = resolveEmailParts(
      { subject, html: htmlContent, plain: plainContent },
      context,
    );

    const recipientName =
      [registration.firstName, registration.lastName]
        .filter(Boolean)
        .join(" ") || undefined;

    const result = await sendEmailNow({
      to: registration.email,
      toName: recipientName,
      fromName: context.eventName,
      replyTo: context.organizerEmail || undefined,
      replyToName: context.organizerName || undefined,
      subject: resolved.subject,
      html: resolved.html,
      plainText: resolved.plain,
      categories: ["custom-one-off"],
      log: { registrationId: registration.id, contextSnapshot: { ...context } },
    });

    switch (result.status) {
      case "SENT":
        return {
          success: true,
          emailLogId: result.emailLogId,
          status: "SENT",
          messageId: result.messageId,
        };
      case "UNCERTAIN":
        // The provider may have sent it: not an error the admin should retry.
        return { success: true, emailLogId: result.emailLogId, status: "UNCERTAIN" };
      case "FAILED":
        throw new AppException(
          ErrorCodes.INTERNAL_ERROR,
          result.error || "Failed to send custom email",
          502,
        );
    }
  }
}
