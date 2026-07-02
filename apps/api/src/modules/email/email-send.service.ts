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
  createEmailLog,
  createEmailLogsBulk,
  updateEmailLogById,
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
} from "@app/integrations";
import { AppException } from "./app-exception";

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

    const resolvedSubject = resolveVariables(template.subject, sampleContext);
    const resolvedHtml = resolveVariables(
      template.htmlContent || "",
      sampleContext,
    );
    const resolvedPlainText = resolveVariables(
      template.plainContent || "",
      sampleContext,
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
    const queued = await createEmailLogsBulk(values);

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
    const queued = await createEmailLogsBulk(values);

    return {
      success: true,
      queued,
      message: `${queued} emails queued for sending`,
    };
  }

  // ==========================================================================
  // SEND CUSTOM ONE-OFF EMAIL (synchronous; EmailLog row created BEFORE sending)
  // ==========================================================================
  async sendCustom(
    event: SendEventContext,
    registrationId: string,
    subject: string,
    content: TiptapDocument,
  ): Promise<{ success: true; emailLogId: string; messageId?: string }> {
    const registration = await getRegistrationForEmailContext(registrationId);
    if (!registration || registration.eventId !== event.id) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Registration not found for this event",
        404,
      );
    }

    const context = await buildEmailContextWithAccess(registration);

    const mjml = renderTemplateToMjml(content);
    const { html: rawHtml } = compileMjmlToHtml(mjml);
    const rawPlain = extractPlainText(content);

    const resolvedSubject = resolveVariables(subject, context);
    const resolvedHtml = resolveVariables(rawHtml, context);
    const resolvedPlain = resolveVariables(rawPlain, context);

    const recipientName =
      [registration.firstName, registration.lastName]
        .filter(Boolean)
        .join(" ") || undefined;

    // Create the EmailLog row FIRST so its id is the provider trackingId and a
    // webhook arriving during/after the send has a row to correlate against.
    const logResult = await createEmailLog({
      templateId: null,
      registrationId: registration.id,
      recipientEmail: registration.email,
      recipientName: recipientName ?? null,
      subject: resolvedSubject,
      status: "SENDING",
      contextSnapshot: context,
    });
    if (!logResult.ok) {
      // trigger is null here, so no dedupe index applies; treat as conflict.
      throw new AppException(
        ErrorCodes.CONFLICT,
        "Resource already exists",
        409,
      );
    }
    const emailLog = logResult.log;

    const result = await getEmailProvider().sendEmail({
      to: registration.email,
      toName: recipientName,
      fromName: context.eventName,
      replyTo: context.organizerEmail || undefined,
      replyToName: context.organizerName || undefined,
      subject: resolvedSubject,
      html: resolvedHtml,
      plainText: resolvedPlain,
      trackingId: emailLog.id,
      categories: ["custom-one-off"],
    });

    if (result.success) {
      await updateEmailLogById(emailLog.id, {
        status: "SENT",
        providerMessageId: result.messageId,
        sentAt: new Date(),
      });
      return {
        success: true,
        emailLogId: emailLog.id,
        messageId: result.messageId,
      };
    }

    await updateEmailLogById(emailLog.id, {
      status: "FAILED",
      errorMessage: result.error || "Unknown error",
      failedAt: new Date(),
    });

    throw new AppException(
      ErrorCodes.INTERNAL_ERROR,
      result.error || "Failed to send custom email",
      502,
    );
  }
}
