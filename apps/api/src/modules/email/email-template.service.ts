import { Injectable } from "@nestjs/common";
import {
  ErrorCodes,
  type AutomaticEmailTrigger,
  type AbstractEmailTrigger,
  type EmailTemplateCategory,
  type ListEmailTemplatesQuery,
  type ListEventEmailLogsQuery,
  type TiptapDocument,
} from "@app/contracts";
import {
  getEmailTemplateById,
  findActiveTemplateForTrigger,
  listEmailTemplates as dbListTemplates,
  insertEmailTemplate,
  updateEmailTemplate as dbUpdateTemplate,
  deleteEmailTemplateById,
  listEventEmailLogs as dbListEventLogs,
  type EmailTemplateRow,
  type EmailTemplateInsert,
  type EventEmailLog,
} from "@app/db";
import {
  renderTemplateToMjml,
  compileMjmlToHtml,
  extractPlainText,
} from "@app/integrations";
import { paginate, getSkip, type PaginatedResult } from "@app/shared";
import { AppException } from "../../core/app-exception";

interface TemplateTriggerState {
  category: EmailTemplateCategory;
  trigger: AutomaticEmailTrigger | null;
  abstractTrigger: AbstractEmailTrigger | null;
}

/** XOR / manual-no-trigger rule (defense-in-depth; the create body zod also enforces it). */
function validateTemplateTriggerState({
  category,
  trigger,
  abstractTrigger,
}: TemplateTriggerState): void {
  if (category === "MANUAL") {
    if (trigger || abstractTrigger) {
      throw new AppException(
        ErrorCodes.BAD_REQUEST,
        "Manual templates should not have triggers",
        400,
      );
    }
    return;
  }

  if (Boolean(trigger) === Boolean(abstractTrigger)) {
    throw new AppException(
      ErrorCodes.BAD_REQUEST,
      "Automatic templates require exactly one trigger",
      400,
    );
  }
}

export interface CreateTemplateArgs {
  clientId: string;
  eventId: string;
  name: string;
  description?: string | null;
  subject: string;
  content: TiptapDocument;
  category: EmailTemplateCategory;
  trigger?: AutomaticEmailTrigger | null;
  abstractTrigger?: AbstractEmailTrigger | null;
  isActive?: boolean;
}

export interface UpdateTemplateArgs {
  name?: string;
  description?: string | null;
  subject?: string;
  content?: TiptapDocument;
  category?: EmailTemplateCategory;
  trigger?: AutomaticEmailTrigger | null;
  abstractTrigger?: AbstractEmailTrigger | null;
  isActive?: boolean;
  /** M11: optimistic-concurrency precondition from GET's `updatedAt`. Omitted → last-write-wins (back-compat). */
  expectedUpdatedAt?: string;
}

@Injectable()
export class EmailTemplateService {
  /** Guard: no active template already owns this event+trigger (409 otherwise). */
  private async assertNoActiveTemplateForTrigger(input: {
    eventId: string;
    trigger: AutomaticEmailTrigger | null;
    abstractTrigger: AbstractEmailTrigger | null;
    excludeId?: string;
  }): Promise<void> {
    if (!input.trigger && !input.abstractTrigger) return;
    const duplicate = await findActiveTemplateForTrigger(input);
    if (duplicate) {
      const trigger = input.trigger ?? input.abstractTrigger;
      throw new AppException(
        ErrorCodes.CONFLICT,
        `An active template for trigger "${trigger}" already exists for this event`,
        409,
      );
    }
  }

  getById(id: string): Promise<EmailTemplateRow | null> {
    return getEmailTemplateById(id);
  }

  async create(input: CreateTemplateArgs): Promise<EmailTemplateRow> {
    const triggerState: TemplateTriggerState = {
      category: input.category,
      trigger: input.trigger ?? null,
      abstractTrigger: input.abstractTrigger ?? null,
    };
    validateTemplateTriggerState(triggerState);
    await this.assertNoActiveTemplateForTrigger({
      eventId: input.eventId,
      trigger: triggerState.trigger,
      abstractTrigger: triggerState.abstractTrigger,
    });

    const mjmlContent = renderTemplateToMjml(input.content);
    const { html: htmlContent } = compileMjmlToHtml(mjmlContent);
    const plainContent = extractPlainText(input.content);

    const values: EmailTemplateInsert = {
      clientId: input.clientId,
      eventId: input.eventId,
      name: input.name,
      description: input.description ?? null,
      subject: input.subject,
      content: input.content,
      mjmlContent,
      htmlContent,
      plainContent,
      category: triggerState.category,
      trigger: triggerState.trigger,
      abstractTrigger: triggerState.abstractTrigger,
      isActive: input.isActive ?? true,
    };

    const result = await insertEmailTemplate(values);
    if (!result.ok) {
      // Race backstop: the one-active-template partial unique index fired.
      throw new AppException(
        ErrorCodes.CONFLICT,
        "Resource already exists",
        409,
      );
    }
    return result.template;
  }

  async update(id: string, input: UpdateTemplateArgs): Promise<EmailTemplateRow> {
    const existing = await getEmailTemplateById(id);
    if (!existing) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Email template not found",
        404,
      );
    }

    const finalCategory = input.category ?? existing.category;
    const finalTrigger =
      input.trigger !== undefined ? input.trigger : existing.trigger;
    const finalAbstractTrigger =
      input.abstractTrigger !== undefined
        ? input.abstractTrigger
        : existing.abstractTrigger;

    const triggerState: TemplateTriggerState =
      finalCategory === "MANUAL"
        ? { category: finalCategory, trigger: null, abstractTrigger: null }
        : {
            category: finalCategory,
            trigger: finalTrigger,
            abstractTrigger: finalAbstractTrigger,
          };
    validateTemplateTriggerState(triggerState);

    const triggerChanged =
      triggerState.trigger !== existing.trigger ||
      triggerState.abstractTrigger !== existing.abstractTrigger ||
      triggerState.category !== existing.category;
    if (triggerState.category === "AUTOMATIC" && triggerChanged) {
      await this.assertNoActiveTemplateForTrigger({
        eventId: existing.eventId!,
        trigger: triggerState.trigger,
        abstractTrigger: triggerState.abstractTrigger,
        excludeId: id,
      });
    }

    const patch: Partial<EmailTemplateInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.subject !== undefined) patch.subject = input.subject;
    if (input.content) {
      patch.content = input.content;
      patch.mjmlContent = renderTemplateToMjml(input.content);
      patch.htmlContent = compileMjmlToHtml(patch.mjmlContent).html;
      patch.plainContent = extractPlainText(input.content);
    }
    if (input.category !== undefined) patch.category = input.category;
    if (
      input.category !== undefined ||
      input.trigger !== undefined ||
      input.abstractTrigger !== undefined
    ) {
      patch.trigger = triggerState.trigger;
      patch.abstractTrigger = triggerState.abstractTrigger;
    }
    if (input.isActive !== undefined) patch.isActive = input.isActive;

    let expectedUpdatedAt: Date | undefined;
    if (input.expectedUpdatedAt !== undefined) {
      expectedUpdatedAt = new Date(input.expectedUpdatedAt);
      if (Number.isNaN(expectedUpdatedAt.getTime())) {
        throw new AppException(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid expectedUpdatedAt precondition",
          400,
        );
      }
    }

    const updated = await dbUpdateTemplate(id, patch, expectedUpdatedAt);
    if (!updated) {
      // `existing` above already proved the row exists, so a miss here means
      // the CAS precondition lost a race against a concurrent edit.
      throw new AppException(
        ErrorCodes.CONCURRENT_MODIFICATION,
        "Email template changed. Refresh and try again.",
        409,
      );
    }
    return updated;
  }

  async delete(id: string): Promise<void> {
    const existing = await getEmailTemplateById(id);
    if (!existing) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Email template not found",
        404,
      );
    }
    await deleteEmailTemplateById(id);
  }

  async duplicate(id: string, newName?: string): Promise<EmailTemplateRow> {
    const existing = await getEmailTemplateById(id);
    if (!existing) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Email template not found",
        404,
      );
    }

    const values: EmailTemplateInsert = {
      clientId: existing.clientId,
      eventId: existing.eventId,
      name: newName || `${existing.name} (Copy)`,
      description: existing.description,
      subject: existing.subject,
      content: existing.content,
      mjmlContent: existing.mjmlContent,
      htmlContent: existing.htmlContent,
      plainContent: existing.plainContent,
      category: "MANUAL", // Duplicates are always manual
      trigger: null,
      abstractTrigger: null,
      isActive: false, // Start as inactive
    };

    const result = await insertEmailTemplate(values);
    if (!result.ok) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        "Resource already exists",
        409,
      );
    }
    return result.template;
  }

  async list(
    eventId: string,
    query: ListEmailTemplatesQuery,
  ): Promise<PaginatedResult<EmailTemplateRow>> {
    const { page, limit, category, trigger, abstractTrigger, search } = query;
    const { data, total } = await dbListTemplates(eventId, {
      category,
      trigger,
      abstractTrigger,
      search,
      skip: getSkip({ page, limit }),
      limit,
    });
    return paginate(data, total, { page, limit });
  }

  async listLogs(
    eventId: string,
    query: ListEventEmailLogsQuery,
  ): Promise<PaginatedResult<EventEmailLog>> {
    const { page, limit, status, trigger } = query;
    const { data, total } = await dbListEventLogs(eventId, {
      status,
      trigger,
      skip: getSkip({ page, limit }),
      limit,
    });
    return paginate(data, total, { page, limit });
  }
}
