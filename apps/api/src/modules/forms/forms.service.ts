import { isDeepStrictEqual } from "node:util";
import { Injectable } from "@nestjs/common";
import {
  ErrorCodes,
  FormSchemaJsonSchema,
  SponsorFormSchemaJsonSchema,
  getSponsorshipMode,
  extractFieldIds,
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
import { AppException } from "./app-exception";

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
    throw new AppException(
      ErrorCodes.VALIDATION_ERROR,
      "Invalid registration form schema structure",
      400,
    );
  }
  return result.data;
}

@Injectable()
export class FormsService {
  // --------------------------------------------------------------------------
  // createForm
  // --------------------------------------------------------------------------
  async createForm(input: CreateFormInput): Promise<Form> {
    const { eventId, name, schema, successTitle, successMessage } = input;

    if (!(await eventExists(eventId))) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }

    if (await formExistsByEventAndType(eventId, "REGISTRATION")) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        "Event already has a form. Update the existing form instead.",
        409,
      );
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
    });
    if (!result.ok) {
      throw new AppException(ErrorCodes.CONFLICT, "Resource already exists", 409);
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
    const form = await findFormById(id);
    if (!form) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Form not found", 404);
    }

    const patch: FormUpdatePatch = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.successTitle !== undefined) patch.successTitle = input.successTitle;
    if (input.successMessage !== undefined)
      patch.successMessage = input.successMessage;

    let nextSchema: FormSchemaJson | SponsorFormSchemaJson | undefined;
    if (input.schema !== undefined) {
      if (form.type === "SPONSOR") {
        const parsed = SponsorFormSchemaJsonSchema.safeParse(input.schema);
        if (!parsed.success) {
          throw new AppException(
            ErrorCodes.VALIDATION_ERROR,
            "Invalid sponsor form schema structure",
            400,
          );
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
            if (result.reason === "not_found") {
              throw new AppException(ErrorCodes.NOT_FOUND, "Form not found", 404);
            }
            if (result.reason === "type_changed") {
              throw new AppException(
                ErrorCodes.VALIDATION_ERROR,
                "Invalid sponsor form schema structure",
                400,
              );
            }
            throw new AppException(
              ErrorCodes.CONFLICT,
              "Cannot change sponsorship mode after sponsorship batches have been submitted",
              409,
            );
          }
          return result.form;
        }
      }

      const newFieldIds = extractFieldIds(nextSchema);
      const removedFields = extractFieldIds(form.schema).filter(
        (fieldId) => !newFieldIds.includes(fieldId),
      );
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
    const form = await findFormById(formId);
    if (!form) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Form not found", 404);
    }
    if (form.type !== "SPONSOR") {
      throw new AppException(
        ErrorCodes.BAD_REQUEST,
        "Sponsorship settings can only be updated for sponsor forms",
        400,
      );
    }

    const currentMode = getSponsorshipMode(form.schema);
    if (settings.sponsorshipMode !== currentMode) {
      const result = await updateSponsorshipSettingsModeChange(formId, settings);
      if (!result.ok) {
        if (result.reason === "not_found") {
          throw new AppException(ErrorCodes.NOT_FOUND, "Form not found", 404);
        }
        if (result.reason === "not_sponsor") {
          throw new AppException(
            ErrorCodes.BAD_REQUEST,
            "Sponsorship settings can only be updated for sponsor forms",
            400,
          );
        }
        throw new AppException(
          ErrorCodes.CONFLICT,
          "Cannot change sponsorship mode after sponsorship batches have been submitted",
          409,
        );
      }
      return result.form;
    }

    const schema = (form.schema ?? {}) as Record<string, unknown>;
    const merged = {
      ...schema,
      sponsorshipSettings: {
        ...((schema.sponsorshipSettings as Record<string, unknown>) ?? {}),
        ...settings,
      },
    };
    return dbUpdateForm(formId, { schema: merged });
  }

  // --------------------------------------------------------------------------
  // deleteForm (two non-transactional statements — kept)
  // --------------------------------------------------------------------------
  async deleteForm(id: string): Promise<void> {
    const form = await findFormById(id);
    if (!form) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Form not found", 404);
    }
    const registrationCount = await countRegistrationsByFormId(id);
    if (registrationCount > 0) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `Cannot delete form with ${registrationCount} existing registration(s). Delete or move registrations first.`,
        409,
      );
    }
    await deleteFormById(id);
  }

  // --------------------------------------------------------------------------
  // createSponsorForm
  // --------------------------------------------------------------------------
  async createSponsorForm(eventId: string, name?: string): Promise<Form> {
    if (!(await eventExists(eventId))) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }
    if (await formExistsByEventAndType(eventId, "SPONSOR")) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        "Event already has a sponsor form. Update the existing form instead.",
        409,
      );
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
      throw new AppException(ErrorCodes.CONFLICT, "Resource already exists", 409);
    }
    return result.form;
  }
}
