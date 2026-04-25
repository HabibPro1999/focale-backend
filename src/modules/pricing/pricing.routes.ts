import {
  requireAuth,
  canAccessClient,
} from "@shared/middleware/auth.middleware.js";
import { assertEventWritable, getEventById } from "@events";
import { assertClientModuleEnabled } from "@clients";
import { validateFormData, sanitizeFormData, type FormSchema } from "@forms";
import {
  getEventPricing,
  updateEventPricing,
  addPricingRule,
  updatePricingRule,
  deletePricingRule,
  calculatePrice,
} from "./pricing.service.js";
import {
  EventIdParamSchema,
  RuleIdParamSchema,
  UpdateEventPricingSchema,
  CreateEmbeddedRuleSchema,
  UpdateEmbeddedRuleSchema,
  CalculatePriceRequestSchema,
  type UpdateEventPricingInput,
  type CreateEmbeddedRuleInput,
  type UpdateEmbeddedRuleInput,
  type CalculatePriceRequest,
} from "./pricing.schema.js";
import { z } from "zod";
import { prisma } from "@/database/client.js";
import type { AppInstance } from "@shared/types/fastify.js";
import { publicRateLimits } from "@core/plugins.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";

const FormIdParamSchema = z.strictObject({
  formId: z.string().uuid(),
});

// ============================================================================
// Event Pricing Routes (Protected)
// ============================================================================

export async function pricingRulesRoutes(app: AppInstance): Promise<void> {
  // All routes require authentication
  app.addHook("onRequest", requireAuth);

  // GET /api/events/:eventId/pricing - Get event pricing (includes embedded rules)
  app.get<{ Params: { eventId: string } }>(
    "/:eventId/pricing",
    {
      schema: { params: EventIdParamSchema },
    },
    async (request, reply) => {
      const { eventId } = request.params;

      // Get event to check ownership
      const event = await getEventById(eventId);
      if (!event) {
        throw app.httpErrors.notFound("Event not found");
      }

      // Check if user is super_admin or accessing their own client's event
      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden(
          "Insufficient permissions to access this event",
        );
      }
      await assertClientModuleEnabled(event.clientId, "pricing");

      const pricing = await getEventPricing(eventId);
      if (!pricing) {
        throw app.httpErrors.notFound("Event pricing not found");
      }

      return reply.send(pricing);
    },
  );

  // PATCH /api/events/:eventId/pricing - Update event pricing (base price, currency, and/or rules)
  app.patch<{ Params: { eventId: string }; Body: UpdateEventPricingInput }>(
    "/:eventId/pricing",
    {
      schema: { params: EventIdParamSchema, body: UpdateEventPricingSchema },
    },
    async (request, reply) => {
      const { eventId } = request.params;

      // Get event to check ownership
      const event = await getEventById(eventId);
      if (!event) {
        throw app.httpErrors.notFound("Event not found");
      }

      // Check if user is super_admin or updating their own client's event
      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden(
          "Insufficient permissions to update this event",
        );
      }
      assertEventWritable(event);
      await assertClientModuleEnabled(event.clientId, "pricing");

      const pricing = await updateEventPricing(eventId, request.body);
      return reply.send(pricing);
    },
  );

  // ============================================================================
  // Embedded Rule Management Routes
  // ============================================================================

  // POST /api/events/:eventId/pricing/rules - Add a pricing rule
  app.post<{ Params: { eventId: string }; Body: CreateEmbeddedRuleInput }>(
    "/:eventId/pricing/rules",
    {
      schema: { params: EventIdParamSchema, body: CreateEmbeddedRuleSchema },
    },
    async (request, reply) => {
      const { eventId } = request.params;

      // Get event to check ownership
      const event = await getEventById(eventId);
      if (!event) {
        throw app.httpErrors.notFound("Event not found");
      }

      // Check if user is super_admin or creating for their own client
      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden(
          "Insufficient permissions to create pricing rules for this event",
        );
      }
      assertEventWritable(event);
      await assertClientModuleEnabled(event.clientId, "pricing");

      const pricing = await addPricingRule(eventId, request.body);
      return reply.status(201).send(pricing);
    },
  );

  // PATCH /api/events/:eventId/pricing/rules/:ruleId - Update a pricing rule
  app.patch<{
    Params: { eventId: string; ruleId: string };
    Body: UpdateEmbeddedRuleInput;
  }>(
    "/:eventId/pricing/rules/:ruleId",
    {
      schema: { params: RuleIdParamSchema, body: UpdateEmbeddedRuleSchema },
    },
    async (request, reply) => {
      const { eventId, ruleId } = request.params;

      // Get event to check ownership
      const event = await getEventById(eventId);
      if (!event) {
        throw app.httpErrors.notFound("Event not found");
      }

      // Check if user is super_admin or updating their own client's event
      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden(
          "Insufficient permissions to update this pricing rule",
        );
      }
      assertEventWritable(event);
      await assertClientModuleEnabled(event.clientId, "pricing");

      const pricing = await updatePricingRule(eventId, ruleId, request.body);
      return reply.send(pricing);
    },
  );

  // DELETE /api/events/:eventId/pricing/rules/:ruleId - Delete a pricing rule
  app.delete<{ Params: { eventId: string; ruleId: string } }>(
    "/:eventId/pricing/rules/:ruleId",
    {
      schema: { params: RuleIdParamSchema },
    },
    async (request, reply) => {
      const { eventId, ruleId } = request.params;

      // Get event to check ownership
      const event = await getEventById(eventId);
      if (!event) {
        throw app.httpErrors.notFound("Event not found");
      }

      // Check if user is super_admin or deleting their own client's event
      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden(
          "Insufficient permissions to delete this pricing rule",
        );
      }
      assertEventWritable(event);
      await assertClientModuleEnabled(event.clientId, "pricing");

      await deletePricingRule(eventId, ruleId);
      return reply.status(204).send();
    },
  );
}

// ============================================================================
// Public Routes (Price Calculation)
// ============================================================================

export async function pricingPublicRoutes(app: AppInstance): Promise<void> {
  // POST /api/forms/:formId/calculate-price - Calculate price (public)
  app.post<{ Params: { formId: string }; Body: CalculatePriceRequest }>(
    "/:formId/calculate-price",
    {
      config: { rateLimit: publicRateLimits.calculatePrice },
      schema: { params: FormIdParamSchema, body: CalculatePriceRequestSchema },
    },
    async (request, reply) => {
      const { formId } = request.params;
      const input = request.body;

      // Get the active registration form and event gates used for public quotes.
      const form = await prisma.form.findUnique({
        where: { id: formId },
        select: {
          eventId: true,
          schema: true,
          type: true,
          active: true,
          event: {
            select: {
              status: true,
              client: { select: { enabledModules: true } },
            },
          },
        },
      });

      if (!form || form.type !== "REGISTRATION" || !form.active) {
        throw app.httpErrors.notFound("Form not found");
      }
      if (form.event.status !== "OPEN") {
        throw new AppError(
          "Event is not accepting registrations",
          400,
          ErrorCodes.EVENT_NOT_OPEN,
        );
      }
      if (!form.event.client.enabledModules.includes("pricing")) {
        throw new AppError(
          "Pricing module is disabled",
          403,
          ErrorCodes.FORBIDDEN,
        );
      }

      const formSchema = form.schema as unknown as FormSchema;
      const validationResult = validateFormData(formSchema, input.formData);
      if (!validationResult.valid) {
        throw new AppError(
          "Form validation failed",
          400,
          ErrorCodes.FORM_VALIDATION_ERROR,
          { fieldErrors: validationResult.errors },
        );
      }

      const sanitizedFormData = sanitizeFormData(formSchema, input.formData);
      const breakdown = await calculatePrice(form.eventId, {
        ...input,
        formData: sanitizedFormData,
      });
      return reply.send(breakdown);
    },
  );
}
