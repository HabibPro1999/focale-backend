import { requireAuth } from "@shared/middleware/auth.middleware.js";
import { requireEventAccess } from "@shared/middleware/access-control.js";
import { getFormById } from "@forms";
import {
  getEventPricing,
  getEventPaymentConfig,
  updateEventPricing,
  addPricingRule,
  updatePricingRule,
  deletePricingRule,
  calculatePrice,
} from "./pricing.service.js";
import {
  EventIdParamSchema,
  FormIdParamSchema,
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
import type { AppInstance } from "@shared/types/fastify.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";

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

      await requireEventAccess(request.user!, eventId);

      const pricing = await getEventPricing(eventId);
      if (!pricing) {
        throw new AppError(
          "Event pricing not found",
          404,
          true,
          ErrorCodes.NOT_FOUND,
        );
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

      await requireEventAccess(request.user!, eventId);

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

      await requireEventAccess(request.user!, eventId);

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

      await requireEventAccess(request.user!, eventId);

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

      await requireEventAccess(request.user!, eventId);

      await deletePricingRule(eventId, ruleId);
      return reply.status(204).send();
    },
  );
}

// ============================================================================
// Public Routes (Payment Config)
// ============================================================================

/**
 * GET /api/public/events/:eventId/payment-config
 * Returns event payment configuration for public consumption (no auth required).
 */
export async function pricingPaymentConfigPublicRoutes(
  app: AppInstance,
): Promise<void> {
  app.get<{ Params: { eventId: string } }>(
    "/:eventId/payment-config",
    {
      schema: { params: EventIdParamSchema },
    },
    async (request, reply) => {
      const { eventId } = request.params;

      const config = await getEventPaymentConfig(eventId);

      if (!config) {
        throw new AppError("Event not found", 404, true, ErrorCodes.NOT_FOUND);
      }

      return reply.send(config);
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
      schema: { params: FormIdParamSchema, body: CalculatePriceRequestSchema },
    },
    async (request, reply) => {
      const { formId } = request.params;
      const input = request.body;

      // Get form to find event
      const form = await getFormById(formId);

      if (!form) {
        throw new AppError("Form not found", 404, true, ErrorCodes.NOT_FOUND);
      }

      const breakdown = await calculatePrice(form.eventId, input);
      return reply.send(breakdown);
    },
  );
}
