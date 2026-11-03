import { Injectable } from "@nestjs/common";
import {
  ErrorCodes,
  type BulkSendEmailInput,
  type DraftEmailPreview,
  type DraftEmailTestSend,
  type EmailTemplateAttachment,
  type TiptapDocument,
} from "@app/contracts";
import {
  getRegistrationForEmailContext,
  getRegistrationFormLanguage,
  getRegistrationsByIds,
  getRegistrationsByFilters,
  listAbstractsForBulkEmail,
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
  getSampleEmailContextForEvent,
  buildTemplateAttachments,
  SAMPLE_REGISTRATION_ID,
  resolveEmailParts,
  buildEmailContextWithAccess,
  buildBatchEmailContext,
  buildAbstractBulkEmailContext,
  resendUncertainEmail,
  sendEmailNow,
} from "@app/integrations";
import { AppException, conflict, notFound } from "../../core/app-exception";
import { compileTemplateContent, getTemplateLanguage } from "./template-content";

/** Minimal event shape the send paths need (subset of EventWithPricing). */
export interface SendEventContext {
  id: string;
  clientId: string;
  name: string;
  startDate: Date;
  endDate: Date;
  location: string | null;
  pricing: { currency: string } | null;
}

/** POST .../email-templates/:templateId/send: `skipped` is 0 outside the abstracts audience. */
export interface BulkSendResult {
  success: true;
  queued: number;
  skipped: number;
  message: string;
}

interface BulkEmailPlan { values: EmailLogInsert[]; skipped: number; emptyMessage: string }

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
    // Sample dates and labels in the template's language (the one its stored
    // HTML was compiled in), with the form fields' sample answers.
    const language = await getTemplateLanguage(template);
    const sampleContext = await getSampleEmailContextForEvent(
      template.eventId,
      language,
    );

    const resolved = resolveEmailParts(
      {
        subject: template.subject,
        html: template.htmlContent || "",
        plain: template.plainContent || "",
      },
      sampleContext,
    );

    return this.deliverTest(
      resolved,
      { attachments: template.attachments, eventId: template.eventId, context: sampleContext },
      recipientEmail,
      recipientName,
    );
  }

  async previewDraft(eventId: string, input: DraftEmailPreview) {
    return (await this.resolveDraft(eventId, input)).resolved;
  }

  async testSendDraft(eventId: string, input: DraftEmailTestSend) {
    const { resolved, context } = await this.resolveDraft(eventId, input);
    return this.deliverTest(
      resolved,
      { attachments: input.attachments, eventId, context },
      input.recipientEmail,
      input.recipientName,
    );
  }

  /** The unsaved draft compiled and resolved against the sample context. */
  private async resolveDraft(eventId: string, input: DraftEmailPreview) {
    const language = input.language ?? await getRegistrationFormLanguage(eventId);
    const compiled = await compileTemplateContent(input.content, language);
    const context = await getSampleEmailContextForEvent(eventId, language);
    const resolved = resolveEmailParts({ subject: input.subject, html: compiled.htmlContent, plain: compiled.plainContent }, context);
    return { resolved, context };
  }

  /**
   * Template attachments are built from the sample registration and the
   * sample context, so the test email carries a real QR code and badge.
   */
  private async deliverTest(
    resolved: { subject: string; html: string; plain: string },
    sample: {
      attachments: readonly EmailTemplateAttachment[];
      eventId: string | null;
      context: Awaited<ReturnType<typeof getSampleEmailContextForEvent>>;
    },
    recipientEmail: string,
    recipientName?: string,
  ): Promise<{ success: true; message: string; messageId?: string }> {
    const attachments = await buildTemplateAttachments(sample.attachments, {
      registrationId: SAMPLE_REGISTRATION_ID,
      eventId: sample.eventId,
      context: sample.context,
    });
    const result = await getEmailProvider().sendEmail({
      to: recipientEmail,
      toName: recipientName,
      subject: `[TEST] ${resolved.subject}`,
      html: resolved.html,
      plainText: resolved.plain,
      categories: ["test-email"],
      ...(attachments.length > 0 && { attachments }),
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
  async countBulkSend(event: SendEventContext, templateId: string, body: BulkSendEmailInput) {
    const plan = await this.planBulkSend(event, templateId, body);
    return { recipientCount: plan.values.length, skipped: plan.skipped };
  }

  async bulkSend(event: SendEventContext, templateId: string, body: BulkSendEmailInput): Promise<BulkSendResult> {
    const plan = await this.planBulkSend(event, templateId, body);
    const queued = plan.values.length
      ? (await withTxn((tx) => insertEmailLogsSkippingConflicts(plan.values, tx))).size : 0;
    return { success: true, queued, skipped: plan.skipped,
      message: plan.values.length ? `${queued} emails queued for sending` : plan.emptyMessage };
  }

  private async planBulkSend(
    event: SendEventContext,
    templateId: string,
    body: BulkSendEmailInput,
  ): Promise<BulkEmailPlan> {
    const { audience, registrationIds, filters } = body;

    if (audience === "sponsors") {
      return this.planSponsorSend(event, templateId);
    }
    if (audience === "abstracts") {
      return this.planAbstractSend(event, templateId, body);
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
        values: [],
        skipped: 0,
        emptyMessage: "No recipients matched the criteria",
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
    return { values, skipped: 0, emptyMessage: "0 emails queued for sending" };
  }

  private async planSponsorSend(
    event: SendEventContext,
    templateId: string,
  ): Promise<BulkEmailPlan> {
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
    const language = await getRegistrationFormLanguage(event.id);
    const sponsors = [...grouped.values()]
      .filter(({ sponsorships }) => sponsorships.length > 0)
      .map(({ batch, sponsorships }) => {
        const context = buildBatchEmailContext({
          batch,
          sponsorships,
          event: {
            name: event.name,
            startDate: event.startDate,
            endDate: event.endDate,
            location: event.location,
            client: { name: client?.name ?? "" },
          },
          currency,
          language,
        });
        return {
          email: batch.email,
          recipientName: batch.contactName,
          contextSnapshot: context as Record<string, unknown>,
        };
      });

    if (sponsors.length === 0) {
      return {
        values: [],
        skipped: 0,
        emptyMessage: "No sponsors found for this event",
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
    return { values, skipped: 0, emptyMessage: "0 emails queued for sending" };
  }

  /**
   * Abstract authors (backend 0f86c91d); the controller has checked the
   * abstracts module. Each row carries its abstract and a context snapshot
   * the worker renders the template from. `skipped` counts the abstracts left
   * out: a blank author email, or (dedupeByEmail) an author's later abstract.
   */
  private async planAbstractSend(
    event: SendEventContext,
    templateId: string,
    { abstractIds, abstractFilters, dedupeByEmail }: BulkSendEmailInput,
  ): Promise<BulkEmailPlan> {
    const { recipients, skipped } = await listAbstractsForBulkEmail(event.id, {
      abstractIds,
      filters: abstractFilters,
      dedupeByEmail,
    });

    if (recipients.length === 0) {
      return {
        values: [],
        skipped,
        emptyMessage: "No abstract submitters matched the criteria",
      };
    }

    const values: EmailLogInsert[] = recipients.map((abstract) =>
      queuedEmailLogValues({
        templateId,
        abstractId: abstract.id,
        recipientEmail: abstract.authorEmail,
        recipientName:
          `${abstract.authorFirstName} ${abstract.authorLastName}`.trim() || null,
        contextSnapshot: buildAbstractBulkEmailContext(abstract),
      }),
    );
    return { values, skipped, emptyMessage: "No abstract submitters matched the criteria" };
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

    const { htmlContent, plainContent } = await compileTemplateContent(
      content,
      registration.language,
    );
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
