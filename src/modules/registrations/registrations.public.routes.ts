import { z } from "zod";
import {
  createRegistration,
  getRegistrationForEdit,
  editRegistrationPublic,
  verifyEditToken,
  uploadPaymentProof,
  getRegistrationByIdempotencyKey,
} from "./registrations.service.js";
import { calculatePrice } from "@pricing";
import { getFormById } from "@forms";
import { getEventById } from "@events";
import {
  CreateRegistrationSchema,
  FormIdParamSchema,
  RegistrationIdPublicParamSchema,
  PublicEditRegistrationSchema,
  type CreateRegistrationInput,
  type PublicEditRegistrationInput,
} from "./registrations.schema.js";
import {
  validateFormData,
  sanitizeFormData,
  type FormSchema,
} from "@shared/utils/form-data-validator.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { publicRateLimits } from "@core/plugins.js";
import type { AppInstance } from "@shared/types/fastify.js";
import type { FastifyRequest } from "fastify";

// Schema for edit token query parameter (optional — also accepted via X-Edit-Token header)
const EditTokenQuerySchema = z
  .object({
    token: z.string().length(64).optional(),
  })
  .strict();

/** Extract edit token from X-Edit-Token header or ?token= query string. Header preferred. */
function extractEditToken(request: FastifyRequest): string {
  const headerToken = request.headers["x-edit-token"] as string | undefined;
  const queryToken = (request.query as { token?: string }).token;
  const token = headerToken || queryToken;
  if (!token || token.length !== 64) {
    throw new AppError(
      "Edit token required",
      401,
      true,
      ErrorCodes.INVALID_TOKEN,
    );
  }
  return token;
}

// ============================================================================
// Public Routes (No Auth - for form submission)
// ============================================================================

export async function registrationsPublicRoutes(
  app: AppInstance,
): Promise<void> {
  // POST /api/public/forms/:formId/register - Submit registration
  app.post<{
    Params: { formId: string };
    Body: Omit<CreateRegistrationInput, "formId">;
  }>(
    "/:formId/register",
    {
      config: {
        rateLimit: publicRateLimits.registration,
      },
      schema: {
        params: FormIdParamSchema,
        body: CreateRegistrationSchema.omit({ formId: true }),
      },
    },
    async (request, reply) => {
      const { formId } = request.params;
      const input: CreateRegistrationInput = { ...request.body, formId };

      // Check idempotency key - return existing registration if found
      if (input.idempotencyKey) {
        const existingRegistration = await getRegistrationByIdempotencyKey(
          input.idempotencyKey,
        );
        if (existingRegistration) {
          // Return existing registration (idempotent response with 200)
          const priceBreakdown = existingRegistration.priceBreakdown as unknown;
          return reply.status(200).send({
            registration: {
              ...existingRegistration,
              token: existingRegistration.editToken, // Map editToken to token for frontend compatibility
            },
            priceBreakdown,
          });
        }
      }

      // Verify form exists
      const form = await getFormById(formId);
      if (!form) {
        throw app.httpErrors.notFound("Form not found");
      }

      // Verify event is OPEN for registrations
      const event = await getEventById(form.eventId);
      if (!event || event.status !== "OPEN") {
        throw app.httpErrors.badRequest("Event is not accepting registrations");
      }

      // Validate formData against form schema
      const validationResult = validateFormData(
        form.schema as unknown as FormSchema,
        input.formData,
      );
      if (!validationResult.valid) {
        throw new AppError(
          "Form validation failed",
          400,
          true,
          ErrorCodes.FORM_VALIDATION_ERROR,
          { fieldErrors: validationResult.errors },
        );
      }

      // Strip unknown keys — keep only field IDs from the form schema
      input.formData = sanitizeFormData(
        form.schema as unknown as FormSchema,
        input.formData,
      );

      // Calculate price breakdown using the event ID from the form
      // Convert access selections to the format expected by calculatePrice
      const selectedExtras =
        input.accessSelections?.map((selection) => ({
          extraId: selection.accessId,
          quantity: selection.quantity,
        })) ?? [];

      const priceBreakdown = await calculatePrice(form.eventId, {
        formData: input.formData,
        selectedExtras,
        sponsorshipCodes: input.sponsorshipCode ? [input.sponsorshipCode] : [],
      });

      // Transform price breakdown to match our schema
      // Note: calculatePrice uses 'extras' terminology, we'll adapt it
      const registrationPriceBreakdown = {
        basePrice: priceBreakdown.basePrice,
        appliedRules: priceBreakdown.appliedRules,
        calculatedBasePrice: priceBreakdown.calculatedBasePrice,
        accessItems: priceBreakdown.extras.map((extra) => ({
          accessId: extra.extraId,
          name: extra.name,
          unitPrice: extra.unitPrice,
          quantity: extra.quantity,
          subtotal: extra.subtotal,
          status: "confirmed" as const, // Will be updated by createRegistration
        })),
        accessTotal: priceBreakdown.extrasTotal,
        subtotal: priceBreakdown.subtotal,
        sponsorships: priceBreakdown.sponsorships,
        sponsorshipTotal: priceBreakdown.sponsorshipTotal,
        total: priceBreakdown.total,
        currency: priceBreakdown.currency,
      };

      // Create registration
      const registration = await createRegistration(
        input,
        registrationPriceBreakdown,
      );

      return reply.status(201).send({
        registration: {
          ...registration,
          token: registration.editToken, // Map editToken to token for frontend compatibility
        },
        priceBreakdown: registrationPriceBreakdown,
      });
    },
  );
}

// ============================================================================
// Public Registration Edit Routes (Self-Service)
// ============================================================================

export async function registrationEditPublicRoutes(
  app: AppInstance,
): Promise<void> {
  // GET /api/public/registrations/:registrationId - Get registration for editing
  // Requires valid edit token in query string
  app.get<{
    Params: { registrationId: string };
    Querystring: { token?: string };
  }>(
    "/:registrationId",
    {
      config: {
        rateLimit: publicRateLimits.editToken,
      },
      schema: {
        params: RegistrationIdPublicParamSchema,
        querystring: EditTokenQuerySchema,
      },
    },
    async (request, reply) => {
      const { registrationId } = request.params;
      const token = extractEditToken(request);

      // Verify edit token before returning any data
      const isValid = await verifyEditToken(registrationId, token);
      if (!isValid) {
        throw app.httpErrors.forbidden("Invalid or expired edit token");
      }

      const result = await getRegistrationForEdit(registrationId);
      return reply.send(result);
    },
  );

  // PATCH /api/public/registrations/:registrationId - Edit registration
  // Requires valid edit token via header or query string
  app.patch<{
    Params: { registrationId: string };
    Querystring: { token?: string };
    Body: PublicEditRegistrationInput;
  }>(
    "/:registrationId",
    {
      config: {
        rateLimit: publicRateLimits.editToken,
      },
      schema: {
        params: RegistrationIdPublicParamSchema,
        querystring: EditTokenQuerySchema,
        body: PublicEditRegistrationSchema,
      },
    },
    async (request, reply) => {
      const { registrationId } = request.params;
      const token = extractEditToken(request);
      const input = request.body;

      // Verify edit token before allowing edit
      const isValid = await verifyEditToken(registrationId, token);
      if (!isValid) {
        throw app.httpErrors.forbidden("Invalid or expired edit token");
      }

      const result = await editRegistrationPublic(registrationId, input);
      return reply.send(result);
    },
  );

  // POST /api/public/registrations/:registrationId/payment-proof - Upload payment proof
  // Requires valid edit token via header or query string
  app.post<{
    Params: { registrationId: string };
    Querystring: { token?: string };
  }>(
    "/:registrationId/payment-proof",
    {
      config: {
        rateLimit: publicRateLimits.paymentProof,
      },
      schema: {
        params: RegistrationIdPublicParamSchema,
        querystring: EditTokenQuerySchema,
      },
    },
    async (request, reply) => {
      const { registrationId } = request.params;
      const token = extractEditToken(request);

      // Verify edit token before allowing upload
      const isValid = await verifyEditToken(registrationId, token);
      if (!isValid) {
        throw app.httpErrors.forbidden("Invalid or expired edit token");
      }

      // Get file from multipart request
      const data = await request.file();
      if (!data) {
        throw app.httpErrors.badRequest("No file uploaded");
      }

      const buffer = await data.toBuffer();
      const result = await uploadPaymentProof(registrationId, {
        buffer,
        filename: data.filename,
        mimetype: data.mimetype,
      });

      return reply.status(201).send(result);
    },
  );
}
