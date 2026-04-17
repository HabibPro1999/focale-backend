import { randomUUID } from "crypto";
import { isDeepStrictEqual } from "node:util";
import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { eventExists } from "@events";
import {
  paginate,
  getSkip,
  type PaginatedResult,
} from "@shared/utils/pagination.js";
import { logger } from "@shared/utils/logger.js";
import { toInputJson, fromInputJson } from "@shared/utils/json.js";
import {
  FormSchemaJsonSchema,
  SponsorFormSchemaJsonSchema,
  type CreateFormInput,
  type UpdateFormInput,
  type ListFormsQuery,
  type FormSchemaJson,
  type SponsorFormSchemaJson,
  type SponsorshipSettings,
  type UpdateSponsorshipSettingsInput,
} from "./forms.schema.js";
import { Prisma } from "@/generated/prisma/client.js";
import type {
  Form,
  Event,
  Client,
  EventAccess,
  EventPricing,
} from "@/generated/prisma/client.js";

type FormWithRelations = Form & {
  event: Event & {
    client: Pick<Client, "id" | "name" | "logo" | "primaryColor" | "phone">;
    pricing: EventPricing | null; // Includes embedded rules in pricing.rules
    access: EventAccess[];
  };
};

/**
 * Generate default form schema with standard registration fields.
 */
function createDefaultSchema(): FormSchemaJson {
  return {
    steps: [
      {
        id: `step_${randomUUID()}`,
        title: "Informations personnelles",
        description: "Tous les champs marqués * sont obligatoires",
        fields: [
          {
            id: `firstName_${randomUUID()}`,
            type: "firstName",
            label: "Prénom",
            placeholder: "Votre prénom",
            required: true,
            width: "half",
          },
          {
            id: `lastName_${randomUUID()}`,
            type: "lastName",
            label: "Nom",
            placeholder: "Votre nom",
            required: true,
            width: "half",
          },
          {
            id: `email_${randomUUID()}`,
            type: "email",
            label: "Email",
            placeholder: "votre.email@exemple.com",
            required: true,
            width: "full",
          },
          {
            id: `phone_${randomUUID()}`,
            type: "phone",
            label: "Téléphone",
            placeholder: "+216 XX XXX XXX",
            required: true,
            width: "full",
            phoneFormat: "TN",
          },
          {
            id: `text_${randomUUID()}`,
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

/**
 * Create a new form.
 * Each event can only have one form (enforced by unique constraint on eventId).
 * If no schema is provided, uses default fields (Prénom, Nom, Email, Téléphone, Lieu de travail).
 */
export async function createForm(input: CreateFormInput): Promise<Form> {
  const { eventId, name, schema, successTitle, successMessage } = input;

  // Validate that event exists
  const isValidEvent = await eventExists(eventId);
  if (!isValidEvent) {
    throw new AppError("Event not found", 404, ErrorCodes.NOT_FOUND);
  }

  // Validate schema shape if provided (before entering transaction)
  if (schema !== undefined) {
    const schemaValidation = FormSchemaJsonSchema.safeParse(schema);
    if (!schemaValidation.success) {
      throw new AppError(
        "Invalid form schema structure",
        400,
        ErrorCodes.INVALID_FORM_SCHEMA,
      );
    }
  }

  // Use provided schema or generate default
  const formSchema = schema ?? createDefaultSchema();

  // Existence check + create in a single transaction to close the concurrent-insert race.
  // DB unique constraint on (eventId, type) catches any slip through; P2002 → 409.
  try {
    return await prisma.$transaction(async (tx) => {
      const existingForm = await tx.form.findFirst({
        where: { eventId, type: "REGISTRATION" },
      });
      if (existingForm) {
        throw new AppError(
          "Event already has a form. Update the existing form instead.",
          409,
          ErrorCodes.CONFLICT,
        );
      }

      return tx.form.create({
        data: {
          eventId,
          name,
          schema: toInputJson(formSchema),
          successTitle: successTitle ?? null,
          successMessage: successMessage ?? null,
        },
      });
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new AppError(
        "Event already has a form. Update the existing form instead.",
        409,
        ErrorCodes.CONFLICT,
      );
    }
    throw err;
  }
}

/**
 * Get form by ID, including the event's clientId for ownership checks.
 */
export async function getFormById(
  id: string,
): Promise<(Form & { event: { clientId: string } }) | null> {
  return prisma.form.findUnique({
    where: { id },
    include: { event: { select: { clientId: true } } },
  });
}

/**
 * Get form by event slug (for public access).
 * Only returns forms for OPEN events with event and client data.
 */
export async function getFormByEventSlug(
  eventSlug: string,
): Promise<FormWithRelations | null> {
  // Find the REGISTRATION form via event slug, including all related data
  const form = await prisma.form.findFirst({
    where: {
      type: "REGISTRATION",
      event: {
        slug: eventSlug,
        status: "OPEN",
      },
      active: true,
    },
    include: {
      event: {
        include: {
          client: {
            select: {
              id: true,
              name: true,
              logo: true,
              primaryColor: true,
              phone: true,
            },
          },
          pricing: true, // Includes embedded rules in pricing.rules
          access: {
            where: { active: true },
            orderBy: [
              { startsAt: "asc" },
              { sortOrder: "asc" },
              { createdAt: "asc" },
            ],
          },
        },
      },
    },
  });

  return form;
}

/**
 * Extract field IDs from form schema.
 * Walks through steps and fields.
 */
function extractFieldIds(schema: unknown): string[] {
  const ids: string[] = [];

  if (!schema || typeof schema !== "object") return ids;

  const schemaObj = schema as {
    steps?: Array<{ fields?: Array<{ id?: string }> }>;
  };

  if (Array.isArray(schemaObj.steps)) {
    for (const step of schemaObj.steps) {
      if (Array.isArray(step.fields)) {
        for (const field of step.fields) {
          if (field.id) {
            ids.push(field.id);
          }
        }
      }
    }
  }

  return ids;
}

/**
 * Update form.
 * Auto-increments schemaVersion when the schema JSON changes.
 * Logs warning when fields with existing registration data are removed.
 */
export async function updateForm(
  id: string,
  input: UpdateFormInput,
): Promise<Form> {
  // Check if form exists
  const form = await prisma.form.findUnique({ where: { id } });
  if (!form) {
    throw new AppError("Form not found", 404, ErrorCodes.NOT_FOUND);
  }

  // Validate sponsor form schema shape when updating a SPONSOR form
  if (form.type === "SPONSOR" && input.schema !== undefined) {
    const schemaValidation = SponsorFormSchemaJsonSchema.safeParse(
      input.schema,
    );
    if (!schemaValidation.success) {
      throw new AppError(
        "Invalid sponsor form schema structure",
        400,
        ErrorCodes.VALIDATION_ERROR,
      );
    }
  }

  // Prepare update data
  const updateData: Prisma.FormUpdateInput = {};
  if (input.name !== undefined) updateData.name = input.name;
  if (input.successTitle !== undefined)
    updateData.successTitle = input.successTitle;
  if (input.successMessage !== undefined)
    updateData.successMessage = input.successMessage;

  // Check if schema is being updated and has actually changed
  if (input.schema !== undefined) {
    if (!isDeepStrictEqual(form.schema, input.schema)) {
      // For SPONSOR forms, validate sponsorship mode changes
      if (form.type === "SPONSOR") {
        const currentSchema = fromInputJson<{
          sponsorshipSettings?: SponsorshipSettings;
        }>(form.schema);
        const newSchema = fromInputJson<{
          sponsorshipSettings?: SponsorshipSettings;
        }>(input.schema);
        const currentMode =
          currentSchema.sponsorshipSettings?.sponsorshipMode ?? "CODE";
        const newMode =
          newSchema.sponsorshipSettings?.sponsorshipMode ?? "CODE";

        // If mode is changing, check if it's locked
        if (currentMode !== newMode) {
          const isLocked = await isSponsorshipModeLocked(id);
          if (isLocked) {
            throw new AppError(
              "Cannot change sponsorship mode after sponsorship batches have been submitted",
              409,
              ErrorCodes.CONFLICT,
            );
          }
        }
      }

      // Check for removed fields that may have registration data
      const oldFieldIds = extractFieldIds(form.schema);
      const newFieldIds = extractFieldIds(input.schema);
      const removedFields = oldFieldIds.filter((f) => !newFieldIds.includes(f));

      if (removedFields.length > 0) {
        // Check if any registrations exist for this form
        const regCount = await prisma.registration.count({
          where: { formId: id },
        });

        if (regCount > 0) {
          logger.warn(
            {
              formId: id,
              removedFields,
              affectedRegistrations: regCount,
            },
            "Form fields removed with existing registration data - data may be orphaned",
          );
        }
      }

      updateData.schema = toInputJson(input.schema);
      // Auto-increment schema version when schema changes
      updateData.schemaVersion = { increment: 1 };
    }
  }

  return prisma.form.update({
    where: { id },
    data: updateData,
  });
}

/**
 * List forms with pagination and filters.
 */
export async function listForms(
  query: ListFormsQuery,
): Promise<PaginatedResult<Form>> {
  const { page, limit, eventId, search, type } = query;
  const skip = getSkip({ page, limit });

  const where: Prisma.FormWhereInput = {};

  if (eventId) where.eventId = eventId;
  if (type) where.type = type;
  if (search) {
    where.OR = [{ name: { contains: search, mode: "insensitive" } }];
  }

  const [data, total] = await Promise.all([
    prisma.form.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
    prisma.form.count({ where }),
  ]);

  return paginate(data, total, { page, limit });
}

/**
 * Delete form.
 */
export async function deleteForm(id: string): Promise<void> {
  // Check if form exists
  const form = await prisma.form.findUnique({ where: { id } });
  if (!form) {
    throw new AppError("Form not found", 404, ErrorCodes.NOT_FOUND);
  }

  // Guard: prevent deletion when registrations exist
  const registrationCount = await prisma.registration.count({
    where: { formId: id },
  });
  if (registrationCount > 0) {
    throw new AppError(
      `Cannot delete form with ${registrationCount} existing registration(s). Delete or move registrations first.`,
      409,
      ErrorCodes.CONFLICT,
    );
  }

  await prisma.form.delete({ where: { id } });
}

/**
 * Check if sponsorship mode is locked for a form.
 * Mode is locked once any sponsorship batch has been submitted.
 */
export async function isSponsorshipModeLocked(
  formId: string,
): Promise<boolean> {
  const count = await prisma.sponsorshipBatch.count({
    where: { formId },
  });
  return count > 0;
}

/**
 * Update sponsorship settings for a SPONSOR form.
 * Only updates the sponsorshipSettings portion of the schema.
 */
export async function updateSponsorshipSettings(
  formId: string,
  settings: UpdateSponsorshipSettingsInput,
): Promise<Form> {
  // Fetch form and verify it's a SPONSOR form
  const form = await prisma.form.findUnique({ where: { id: formId } });
  if (!form) {
    throw new AppError("Form not found", 404, ErrorCodes.NOT_FOUND);
  }

  if (form.type !== "SPONSOR") {
    throw new AppError(
      "Sponsorship settings can only be updated for sponsor forms",
      400,
      ErrorCodes.BAD_REQUEST,
    );
  }

  // Get current schema and settings
  const currentSchema = fromInputJson<SponsorFormSchemaJson>(form.schema);
  const currentMode =
    currentSchema.sponsorshipSettings?.sponsorshipMode ?? "CODE";

  // If mode is changing, check if it's locked
  if (settings.sponsorshipMode !== currentMode) {
    const isLocked = await isSponsorshipModeLocked(formId);
    if (isLocked) {
      throw new AppError(
        "Cannot change sponsorship mode after sponsorship batches have been submitted",
        409,
        ErrorCodes.CONFLICT,
      );
    }
  }

  // Merge new settings into schema
  const updatedSchema: SponsorFormSchemaJson = {
    ...currentSchema,
    sponsorshipSettings: {
      ...currentSchema.sponsorshipSettings,
      ...settings,
    },
  };

  // Validate merged schema before persisting
  const mergedValidation = SponsorFormSchemaJsonSchema.safeParse(updatedSchema);
  if (!mergedValidation.success) {
    throw new AppError(
      "Invalid sponsor form schema after settings merge",
      400,
      ErrorCodes.INVALID_FORM_SCHEMA,
    );
  }

  return prisma.form.update({
    where: { id: formId },
    data: {
      schema: toInputJson(updatedSchema),
    },
  });
}

// ============================================================================
// Sponsor Form Functions
// ============================================================================

/**
 * Create default sponsor form schema with standard lab and beneficiary fields.
 */
export function createDefaultSponsorSchema(): SponsorFormSchemaJson {
  return {
    formType: "SPONSOR",
    sponsorSteps: [
      {
        id: `step_${randomUUID()}`,
        title: "Informations du laboratoire",
        fields: [
          {
            id: "labName",
            type: "text",
            label: "Nom du laboratoire",
            gridColumn: "full",
          },
          {
            id: "contactName",
            type: "text",
            label: "Nom du contact",
            gridColumn: "half",
          },
          {
            id: "email",
            type: "email",
            label: "Email",
            gridColumn: "half",
          },
          {
            id: "phone",
            type: "phone",
            label: "Téléphone",
            gridColumn: "half",
          },
        ],
      },
    ],
    beneficiaryTemplate: {
      fields: [
        {
          id: "name",
          type: "text",
          label: "Nom complet",
          gridColumn: "full",
        },
        {
          id: "email",
          type: "email",
          label: "Email",
          gridColumn: "half",
        },
        {
          id: "phone",
          type: "phone",
          label: "Téléphone",
          gridColumn: "half",
        },
        {
          id: "address",
          type: "textarea",
          label: "Adresse",
          gridColumn: "full",
        },
      ],
      minCount: 1,
      maxCount: 100,
    },
    sponsorshipSettings: {
      sponsorshipMode: "CODE",
    },
  };
}

/**
 * Get sponsor form by event slug (for public access).
 * Only returns forms for OPEN events with event, pricing, and access data.
 */
export async function getSponsorFormByEventSlug(
  slug: string,
): Promise<FormWithRelations | null> {
  const form = await prisma.form.findFirst({
    where: {
      type: "SPONSOR",
      event: {
        slug,
        status: "OPEN",
      },
      active: true,
    },
    include: {
      event: {
        include: {
          client: {
            select: {
              id: true,
              name: true,
              logo: true,
              primaryColor: true,
              phone: true,
            },
          },
          pricing: true,
          access: {
            where: { active: true },
            orderBy: [
              { startsAt: "asc" },
              { sortOrder: "asc" },
              { createdAt: "asc" },
            ],
          },
        },
      },
    },
  });

  return form;
}

/**
 * Get sponsor form by event ID (for admin access).
 */
export async function getSponsorFormByEventId(
  eventId: string,
): Promise<Form | null> {
  return prisma.form.findFirst({
    where: { eventId, type: "SPONSOR" },
  });
}

/**
 * Create sponsor form with default schema.
 */
export async function createSponsorForm(
  eventId: string,
  name?: string,
): Promise<Form> {
  // Validate that event exists
  const isValidEvent = await eventExists(eventId);
  if (!isValidEvent) {
    throw new AppError("Event not found", 404, ErrorCodes.NOT_FOUND);
  }

  const schema = createDefaultSponsorSchema();

  // Existence check + create in a single transaction to close the concurrent-insert race.
  // DB unique constraint on (eventId, type) catches any slip through; P2002 → 409.
  try {
    return await prisma.$transaction(async (tx) => {
      const existingForm = await tx.form.findFirst({
        where: { eventId, type: "SPONSOR" },
      });
      if (existingForm) {
        throw new AppError(
          "Event already has a sponsor form. Update the existing form instead.",
          409,
          ErrorCodes.CONFLICT,
        );
      }

      return tx.form.create({
        data: {
          eventId,
          type: "SPONSOR",
          name: name || "Formulaire Sponsor",
          schema: toInputJson(schema),
          active: true,
        },
      });
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new AppError(
        "Event already has a sponsor form. Update the existing form instead.",
        409,
        ErrorCodes.CONFLICT,
      );
    }
    throw err;
  }
}
