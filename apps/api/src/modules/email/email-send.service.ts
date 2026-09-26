import { Injectable } from "@nestjs/common";
import {
  ErrorCodes,
  type BulkSendEmailInput,
  type TiptapDocument,
} from "@app/contracts";
import {
  getRegistrationForEmailContext,
  getRegistrationsByIds,
  getRegistrationsByFilters,
  listSponsorshipBatchesForBulk,
  getClientById,
  insertEmailLogsSkippingConflicts,
  withTxn,
  type EmailTemplateRow,
  type EmailLogInsert,
} from "@app/db";
import {
  getEmailProvider,
  getSampleEmailContext,
  resolveVariables,
  buildEmailContextWithAccess,
  buildBatchEmailContext,
  renderTemplateToMjml,
  compileMjmlToHtml,
  extractPlainText,
  resendUncertainEmail,
  sendEmailNow,
} from "@app/integrations";
import { AppException } from "../../core/app-exception";

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
    const sampleContext = getSampleEmailContext();

    const resolvedSubject = resolveVariables(template.subject, sampleContext, {
      mode: "text",
    });
    const resolvedHtml = resolveVariables(
      template.htmlContent || "",
      sampleContext,
    );
    const resolvedPlainText = resolveVariables(
      template.plainContent || "",
      sampleContext,
      { mode: "text" },
    );

    const result = await getEmailProvider().sendEmail({
      to: recipientEmail,
      toName: recipientName,
      subject: `[TEST] ${resolvedSubject}`,
      html: resolvedHtml,
      plainText: resolvedPlainText,
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

    let registrations: {
      id: string;
      email: string;
      firstName: string | null;
      lastName: string | null;
    }[];

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

    const values: EmailLogInsert[] = registrations.map((reg) => ({
      templateId,
      registrationId: reg.id,
      recipientEmail: reg.email,
      recipientName:
        [reg.firstName, reg.lastName].filter(Boolean).join(" ") || null,
      subject: "",
      status: "QUEUED",
    }));
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
    const values: EmailLogInsert[] = valid.map((s) => ({
      templateId,
      recipientEmail: s.email,
      recipientName: s.recipientName || null,
      subject: "",
      status: "QUEUED",
      contextSnapshot: s.contextSnapshot,
    }));
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
        throw new AppException(ErrorCodes.NOT_FOUND, "Email log not found", 404);
      case "not_uncertain":
        throw new AppException(
          ErrorCodes.CONFLICT,
          "Only an UNCERTAIN email can be resent",
          409,
        );
      case "not_resendable":
        throw new AppException(
          ErrorCodes.CONFLICT,
          "This email cannot be resent from its log; send it again from where it was sent",
          409,
        );
      case "already_active":
        throw new AppException(
          ErrorCodes.CONFLICT,
          "An active email already covers this one",
          409,
        );
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

    const mjml = renderTemplateToMjml(content);
    const { html: rawHtml } = await compileMjmlToHtml(mjml);
    const rawPlain = extractPlainText(content);

    const resolvedSubject = resolveVariables(subject, context, { mode: "text" });
    const resolvedHtml = resolveVariables(rawHtml, context);
    const resolvedPlain = resolveVariables(rawPlain, context, { mode: "text" });

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
      subject: resolvedSubject,
      html: resolvedHtml,
      plainText: resolvedPlain,
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
