import { z } from "zod";
import {
  createRegistration,
  getRegistrationByIdempotencyKey,
  toPersistablePriceBreakdown,
} from "./registration-crud.service.js";
import { uploadPaymentProof } from "./registration-payment.service.js";
import {
  getRegistrationForEdit,
  editRegistrationPublic,
  verifyEditToken,
} from "./registration-edit.service.js";
import { calculatePrice } from "@pricing";
import { getFormById } from "@forms";
import { getEventById } from "@events";
import { RegistrationIdParamSchema } from "@shared/schemas/params.js";
import {
  FormIdParamSchema,
  PublicEditRegistrationSchema,
  type CreateRegistrationInput,
  type PublicEditRegistrationInput,
} from "./registrations.schema.js";
import { AccessSelectionSchema } from "@access";
import { validateFormData, type FormSchema } from "./form-data-validator.js";
import { AppError } from "@shared/errors.js";
import { ErrorCodes } from "@shared/errors.js";
import type { AppInstance } from "@shared/fastify.js";

// ============================================================================
// Inline request schemas
// ============================================================================

// formId comes from URL param — body omits it
const CreateRegistrationBodySchema = z
  .object({
    formData: z.record(z.string(), z.unknown()),
    email: z.string().email(),
    firstName: z.string().max(100).optional(),
    lastName: z.string().max(100).optional(),
    phone: z.string().max(50).optional(),
    accessSelections: z.array(AccessSelectionSchema).optional().default([]),
    sponsorshipCode: z.string().max(50).optional(),
    idempotencyKey: z.string().uuid().optional(),
    linkBaseUrl: z.string().url().optional(),
  })
  .strict();

const publicRateLimits = {
  registration: { max: 5, timeWindow: "1 minute" },
  paymentProof: { max: 10, timeWindow: "1 minute" },
  editToken: { max: 3, timeWindow: "1 minute" },
} as const;

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
        body: CreateRegistrationBodySchema,
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
          return reply.status(200).send({
            registration: {
              id: existingRegistration.id,
              email: existingRegistration.email,
              totalAmount: existingRegistration.totalAmount,
              currency: existingRegistration.currency,
              paymentStatus: existingRegistration.paymentStatus,
              token: existingRegistration.editToken,
            },
          });
        }
      }

      // Verify form exists
      const form = await getFormById(formId);
      if (!form) {
        throw new AppError("Form not found", 404, true, ErrorCodes.NOT_FOUND);
      }

      // Verify event is OPEN for registrations
      const event = await getEventById(form.eventId);
      if (!event || event.status !== "OPEN") {
        throw new AppError(
          "Event is not accepting registrations",
          400,
          true,
          ErrorCodes.EVENT_NOT_OPEN,
        );
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

      // Transform price breakdown using shared helper
      const registrationPriceBreakdown =
        toPersistablePriceBreakdown(priceBreakdown);

      // Create registration
      const registration = await createRegistration(
        input,
        registrationPriceBreakdown,
      );

      return reply.status(201).send({
        registration: {
          id: registration.id,
          email: registration.email,
          totalAmount: registration.totalAmount,
          currency: registration.currency,
          paymentStatus: registration.paymentStatus,
          token: registration.editToken,
        },
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
  // Requires valid edit token in X-Edit-Token header
  app.get<{
    Params: { registrationId: string };
  }>(
    "/:registrationId",
    {
      config: {
        rateLimit: publicRateLimits.editToken,
      },
      schema: {
        params: RegistrationIdParamSchema,
      },
    },
    async (request, reply) => {
      const { registrationId } = request.params;
      const token = request.headers["x-edit-token"] as string | undefined;
      if (!token || token.length !== 64) {
        throw new AppError(
          "Edit token required",
          401,
          true,
          ErrorCodes.UNAUTHORIZED,
        );
      }

      // Verify edit token before returning any data
      const isValid = await verifyEditToken(registrationId, token);
      if (!isValid) {
        throw new AppError(
          "Invalid or expired edit token",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
      }

      const result = await getRegistrationForEdit(registrationId);
      return reply.send(result);
    },
  );

  // PATCH /api/public/registrations/:registrationId - Edit registration
  // Requires valid edit token in X-Edit-Token header
  app.patch<{
    Params: { registrationId: string };
    Body: PublicEditRegistrationInput;
  }>(
    "/:registrationId",
    {
      config: {
        rateLimit: publicRateLimits.editToken,
      },
      schema: {
        params: RegistrationIdParamSchema,
        body: PublicEditRegistrationSchema,
      },
    },
    async (request, reply) => {
      const { registrationId } = request.params;
      const token = request.headers["x-edit-token"] as string | undefined;
      if (!token || token.length !== 64) {
        throw new AppError(
          "Edit token required",
          401,
          true,
          ErrorCodes.UNAUTHORIZED,
        );
      }
      const input = request.body;

      // Verify edit token before allowing edit
      const isValid = await verifyEditToken(registrationId, token);
      if (!isValid) {
        throw new AppError(
          "Invalid or expired edit token",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
      }

      const result = await editRegistrationPublic(registrationId, input);
      return reply.send(result);
    },
  );

  // POST /api/public/registrations/:registrationId/payment-proof - Upload payment proof
  // Requires valid edit token in X-Edit-Token header
  app.post<{
    Params: { registrationId: string };
  }>(
    "/:registrationId/payment-proof",
    {
      config: {
        rateLimit: publicRateLimits.paymentProof,
      },
      schema: {
        params: RegistrationIdParamSchema,
      },
    },
    async (request, reply) => {
      const { registrationId } = request.params;
      const token = request.headers["x-edit-token"] as string | undefined;
      if (!token || token.length !== 64) {
        throw new AppError(
          "Edit token required",
          401,
          true,
          ErrorCodes.UNAUTHORIZED,
        );
      }

      // Verify edit token before allowing upload
      const isValid = await verifyEditToken(registrationId, token);
      if (!isValid) {
        throw new AppError(
          "Invalid or expired edit token",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
      }

      // Get file from multipart request
      const data = await request.file();
      if (!data) {
        throw new AppError(
          "No file uploaded",
          400,
          true,
          ErrorCodes.VALIDATION_ERROR,
        );
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
