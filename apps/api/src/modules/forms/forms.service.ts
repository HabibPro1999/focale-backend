import { isDeepStrictEqual } from "node:util";
import { Injectable } from "@nestjs/common";
import {
  ErrorCodes,
  FormSchemaJsonSchema,
  SponsorFormSchemaJsonSchema,
  getSponsorshipMode,
  removedFieldIds,
  mergeSponsorshipSettings,
  type CreateFormInput,
  type UpdateFormInput,
  type ListFormsQuery,
  type FormSchemaJson,
  type SponsorFormSchemaJson,
  type UpdateSponsorshipSettingsInput,
} from "@app/contracts";
import {
  eventExists,
  formExistsByEventAndType,
  insertForm,
  findFormById,
  findFormByIdWithEvent,
  findRegistrationFormByEventSlug,
  findSponsorFormByEventSlug,
  findSponsorFormByEventId,
  countRegistrationsByFormId,
  countSponsorshipBatchesByFormId,
  deleteFormById,
  updateForm as dbUpdateForm,
  listForms as dbListForms,
  updateSponsorFormSchemaModeChange,
  updateSponsorshipSettingsModeChange,
  type Form,
  type FormWithEvent,
  type FormWithRelations,
  type FormUpdatePatch,
} from "@app/db";
import { newId, paginate, getSkip, type PaginatedResult } from "@app/shared";
import { logger } from "../../core/logger.service";
import { AppException, notFound, conflict, badRequest, orNotFound } from "../../core/app-exception";

function throwModeChangeFailure(reason: "not_found" | "type_changed" | "not_sponsor" | "locked", typeMismatch: () => AppException): never {
  if (reason === "not_found") throw notFound("Form not found");
  if (reason === "type_changed" || reason === "not_sponsor") throw typeMismatch();
  throw conflict("Cannot change sponsorship mode after sponsorship batches have been submitted");
}

// ============================================================================
// Default schema generators (pure)
// ============================================================================

/** Default registration form schema. */
export function createDefaultSchema(): FormSchemaJson {
  return {
    steps: [
      {
        id: `step_${newId()}`,
        title: "Informations personnelles",
        description: "Tous les champs marqués * sont obligatoires",
        fields: [
          {
            id: `firstName_${newId()}`,
            type: "firstName",
            label: "Prénom",
            placeholder: "Votre prénom",
            required: true,
            width: "half",
          },
          {
            id: `lastName_${newId()}`,
            type: "lastName",
            label: "Nom",
            placeholder: "Votre nom",
            required: true,
            width: "half",
          },
          {
            id: `email_${newId()}`,
            type: "email",
            label: "Email",
            placeholder: "votre.email@exemple.com",
            required: true,
            width: "full",
          },
          {
            id: `phone_${newId()}`,
            type: "phone",
            label: "Téléphone",
            placeholder: "+216 XX XXX XXX",
            required: true,
            width: "full",
            phoneFormat: "TN",
          },
          {
            id: `text_${newId()}`,
            type: "text",
            label: "Lieu de travail",
            placeholder: "Nom de votre entreprise ou établissement",
            required: true,
            width: "full",
          },
        ],
      },
    ],
  };
}

/** Default sponsor form schema (fixed field ids — external contract). */
export function createDefaultSponsorSchema(): SponsorFormSchemaJson {
  return {
    formType: "SPONSOR",
    sponsorSteps: [
      {
        id: `step_${newId()}`,
        title: "Informations du laboratoire",
        fields: [
          { id: "labName", type: "text", label: "Nom du laboratoire", gridColumn: "full" },
          { id: "contactName", type: "text", label: "Nom du contact", gridColumn: "half" },
          { id: "email", type: "email", label: "Email", gridColumn: "half" },
          { id: "phone", type: "phone", label: "Téléphone", gridColumn: "half" },
        ],
      },
    ],
    beneficiaryTemplate: {
      fields: [
        { id: "name", type: "text", label: "Nom complet", gridColumn: "full" },
        { id: "email", type: "email", label: "Email", gridColumn: "half" },
        { id: "phone", type: "phone", label: "Téléphone", gridColumn: "half" },
        { id: "address", type: "textarea", label: "Adresse", gridColumn: "full" },
      ],
      minCount: 1,
      maxCount: 100,
    },
    sponsorshipSettings: { sponsorshipMode: "CODE" },
  };
}

function assertRegistrationFormSchema(schema: unknown): FormSchemaJson {
  const result = FormSchemaJsonSchema.safeParse(schema);
  if (!result.success) {
    throw badRequest("Invalid registration form schema structure");
  }
  return result.data;
}

@Injectable()
export class FormsService {
  // --------------------------------------------------------------------------
  // createForm
  // --------------------------------------------------------------------------
  async createForm(input: CreateFormInput): Promise<Form> {
    const { eventId, name, schema, successTitle, successMessage, successTranslations } = input;

    if (!(await eventExists(eventId))) {
      throw notFound("Event not found");
    }

    if (await formExistsByEventAndType(eventId, "REGISTRATION")) {
      throw conflict("Event already has a form. Update the existing form instead.");
    }

    const formSchema =
      schema !== undefined
        ? assertRegistrationFormSchema(schema)
        : createDefaultSchema();

    const result = await insertForm({
      eventId,
      name,
      schema: formSchema,
      successTitle: successTitle ?? null,
      successMessage: successMessage ?? null,
      successTranslations: successTranslations ?? null,
    });
    if (!result.ok) {
      throw conflict("Resource already exists");
    }
    return result.form;
  }

  // --------------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------------
  getFormById(id: string): Promise<FormWithEvent | null> {
    return findFormByIdWithEvent(id);
  }

  getFormByEventSlug(slug: string): Promise<FormWithRelations | null> {
    return findRegistrationFormByEventSlug(slug);
  }

  getSponsorFormByEventSlug(slug: string): Promise<FormWithRelations | null> {
    return findSponsorFormByEventSlug(slug);
  }

  getSponsorFormByEventId(eventId: string): Promise<Form | null> {
    return findSponsorFormByEventId(eventId);
  }

  async listForms(query: ListFormsQuery): Promise<PaginatedResult<Form>> {
    const { page, limit, eventId, search, type } = query;
    const { data, total } = await dbListForms(
      { eventId, type, search },
      getSkip({ page, limit }),
      limit,
    );
    return paginate(data, total, { page, limit });
  }

  // --------------------------------------------------------------------------
  // updateForm
  // --------------------------------------------------------------------------
  async updateForm(id: string, input: UpdateFormInput): Promise<Form> {
    const form = orNotFound(await findFormById(id), "Form not found");

    const patch: FormUpdatePatch = {
      name: input.name, successTitle: input.successTitle,
      successMessage: input.successMessage, successTranslations: input.successTranslations,
    };

    let nextSchema: FormSchemaJson | SponsorFormSchemaJson | undefined;
    if (input.schema !== undefined) {
      if (form.type === "SPONSOR") {
        const parsed = SponsorFormSchemaJsonSchema.safeParse(input.schema);
        if (!parsed.success) {
          throw badRequest("Invalid sponsor form schema structure");
        }
        nextSchema = parsed.data;
      } else {
        nextSchema = assertRegistrationFormSchema(input.schema);
      }
    }

    if (nextSchema !== undefined && !isDeepStrictEqual(form.schema, nextSchema)) {
      if (form.type === "SPONSOR") {
        const newMode = getSponsorshipMode(nextSchema);
        const currentMode = getSponsorshipMode(form.schema);
        if (currentMode !== newMode) {
          const result = await updateSponsorFormSchemaModeChange({
            id,
            patch,
            nextSchema,
            newMode,
          });
          if (!result.ok) {
            throwModeChangeFailure(result.reason, () => badRequest("Invalid sponsor form schema structure"));
          }
          return result.form;
        }
      }

      const removedFields = removedFieldIds(form.schema, nextSchema);
      if (removedFields.length > 0) {
        const regCount = await countRegistrationsByFormId(id);
        if (regCount > 0) {
          logger.warn(
            { formId: id, removedFields, affectedRegistrations: regCount },
            "Form fields removed with existing registration data - data may be orphaned",
          );
        }
      }

      patch.schema = nextSchema;
      patch.incrementSchemaVersion = true;
    }

    return dbUpdateForm(id, patch);
  }

  // --------------------------------------------------------------------------
  // Sponsorship settings
  // --------------------------------------------------------------------------
  async isSponsorshipModeLocked(formId: string): Promise<boolean> {
    return (await countSponsorshipBatchesByFormId(formId)) > 0;
  }

  async updateSponsorshipSettings(
    formId: string,
    settings: UpdateSponsorshipSettingsInput,
  ): Promise<Form> {
    const form = orNotFound(await findFormById(formId), "Form not found");

    if (form.type !== "SPONSOR") {
      throw badRequest("Sponsorship settings can only be updated for sponsor forms", { code: ErrorCodes.BAD_REQUEST });
    }

    const currentMode = getSponsorshipMode(form.schema);
    if (settings.sponsorshipMode !== currentMode) {
      const result = await updateSponsorshipSettingsModeChange(formId, settings);
      if (!result.ok) {
        throwModeChangeFailure(result.reason, () => badRequest("Sponsorship settings can only be updated for sponsor forms", { code: ErrorCodes.BAD_REQUEST }));
      }
      return result.form;
    }

    const merged = mergeSponsorshipSettings(form.schema, settings);
    return dbUpdateForm(formId, { schema: merged });
  }

  // --------------------------------------------------------------------------
  // deleteForm (two non-transactional statements — kept)
  // --------------------------------------------------------------------------
  async deleteForm(id: string): Promise<void> {
    const form = orNotFound(await findFormById(id), "Form not found");

    const registrationCount = await countRegistrationsByFormId(id);
    if (registrationCount > 0) {
      throw conflict(`Cannot delete form with ${registrationCount} existing registration(s). Delete or move registrations first.`);
    }
    await deleteFormById(id);
  }

  // --------------------------------------------------------------------------
  // createSponsorForm
  // --------------------------------------------------------------------------
  async createSponsorForm(eventId: string, name?: string): Promise<Form> {
    if (!(await eventExists(eventId))) {
      throw notFound("Event not found");
    }
    if (await formExistsByEventAndType(eventId, "SPONSOR")) {
      throw conflict("Event already has a sponsor form. Update the existing form instead.");
    }

    const schema = createDefaultSponsorSchema();
    const result = await insertForm({
      eventId,
      type: "SPONSOR",
      name: name || "Formulaire Sponsor",
      schema,
      active: true,
    });
    if (!result.ok) {
      throw conflict("Resource already exists");
    }
    return result.form;
  }
}
