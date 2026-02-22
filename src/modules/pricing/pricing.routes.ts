import { z } from "zod";
import {
  requireAuth,
  requireEventAccess,
} from "@shared/middleware/auth.middleware.js";
import { EventIdParamSchema } from "@shared/schemas/params.js";
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
  EmbeddedPricingRuleSchema,
  PricingConditionSchema,
  MAX_PRICING_RULES,
} from "./pricing.schema.js";
import type { AppInstance } from "@shared/fastify.js";
import { AppError } from "@shared/errors.js";
import { ErrorCodes } from "@shared/errors.js";

// ============================================================================
// Event Pricing Routes (Protected)
// ============================================================================

export async function pricingRulesRoutes(app: AppInstance): Promise<void> {
  // All routes require authentication
  app.addHook("onRequest", requireAuth);

  const updateEventPricingBody = z
    .object({
      basePrice: z.number().int().min(0).optional(),
      currency: z.string().length(3).optional(),
      rules: z
        .array(EmbeddedPricingRuleSchema)
        .max(MAX_PRICING_RULES)
        .optional(),
      onlinePaymentEnabled: z.boolean().optional(),
      onlinePaymentUrl: z.string().url().optional().nullable(),
      bankName: z.string().max(200).optional().nullable(),
      bankAccountName: z.string().max(200).optional().nullable(),
      bankAccountNumber: z.string().max(50).optional().nullable(),
    })
    .strict();

  const createEmbeddedRuleBody = EmbeddedPricingRuleSchema.omit({ id: true });

  const updateEmbeddedRuleBody = z
    .object({
      name: z.string().min(1).max(200).optional(),
      description: z.string().max(1000).optional().nullable(),
      priority: z.number().int().min(0).optional(),
      conditions: z.array(PricingConditionSchema).min(1).optional(),
      conditionLogic: z.enum(["and", "or"]).optional(),
      price: z.number().int().min(0).optional(),
      active: z.boolean().optional(),
    })
    .strict();

  const ruleIdParams = z
    .object({
      eventId: z.string().uuid(),
      ruleId: z.string().uuid(),
    })
    .strict();

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
  app.patch<{
    Params: { eventId: string };
    Body: z.infer<typeof updateEventPricingBody>;
  }>(
    "/:eventId/pricing",
    {
      schema: { params: EventIdParamSchema, body: updateEventPricingBody },
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
  app.post<{
    Params: { eventId: string };
    Body: z.infer<typeof createEmbeddedRuleBody>;
  }>(
    "/:eventId/pricing/rules",
    {
      schema: { params: EventIdParamSchema, body: createEmbeddedRuleBody },
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
    Body: z.infer<typeof updateEmbeddedRuleBody>;
  }>(
    "/:eventId/pricing/rules/:ruleId",
    {
      schema: { params: ruleIdParams, body: updateEmbeddedRuleBody },
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
      schema: { params: ruleIdParams },
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
  const formIdParams = z.object({ formId: z.string().uuid() }).strict();

  const calculatePriceBody = z
    .object({
      formData: z.record(z.string(), z.unknown()),
      selectedExtras: z
        .array(
          z
            .object({
              extraId: z.string().uuid(),
              quantity: z.number().int().min(1).default(1),
            })
            .strict(),
        )
        .optional()
        .default([]),
      sponsorshipCodes: z.array(z.string()).optional().default([]),
    })
    .strict();

  // POST /api/forms/:formId/calculate-price - Calculate price (public)
  app.post<{
    Params: { formId: string };
    Body: z.infer<typeof calculatePriceBody>;
  }>(
    "/:formId/calculate-price",
    {
      schema: { params: formIdParams, body: calculatePriceBody },
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
