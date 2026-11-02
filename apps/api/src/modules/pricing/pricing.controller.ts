import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { ErrorCodes } from "@app/contracts";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { Auth } from "../../core/auth/auth.decorator";
import { AppException } from "../../core/app-exception";
import { EventScoped } from "../tenancy";
import { PricingService } from "./pricing.service";
import {
  CreateEmbeddedRuleDto,
  EventIdParamDto,
  RuleIdParamDto,
  UpdateEmbeddedRuleDto,
  UpdateEventPricingDto,
} from "./pricing.dto";

@Controller("api/events")
@Auth()
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  // GET /api/events/:eventId/pricing
  @Get(":eventId/pricing")
  @EventScoped({ module: "pricing" })
  async getPricing(@Param() { eventId }: EventIdParamDto) {
    const pricing = await this.pricing.getEventPricing(eventId);
    if (!pricing) {
      throw new AppException(ErrorCodes.PRICING_NOT_FOUND, "Event pricing not found", 404);
    }
    return pricing;
  }

  // PATCH /api/events/:eventId/pricing
  @Patch(":eventId/pricing")
  @EventScoped({ module: "pricing", write: true })
  async updatePricing(
    @Param() { eventId }: EventIdParamDto,
    @Body() body: UpdateEventPricingDto,
  ) {
    return this.pricing.updateEventPricing(eventId, body);
  }

  // POST /api/events/:eventId/pricing/rules — 201
  @Post(":eventId/pricing/rules")
  @EventScoped({ module: "pricing", write: true })
  @HttpCode(201)
  async addRule(
    @Param() { eventId }: EventIdParamDto,
    @Body() body: CreateEmbeddedRuleDto,
  ) {
    return this.pricing.addPricingRule(eventId, body);
  }

  // PATCH /api/events/:eventId/pricing/rules/:ruleId
  @Patch(":eventId/pricing/rules/:ruleId")
  @EventScoped({ module: "pricing", write: true })
  async updateRule(
    @Param() { eventId, ruleId }: RuleIdParamDto,
    @Body() body: UpdateEmbeddedRuleDto,
  ) {
    return this.pricing.updatePricingRule(eventId, ruleId, body);
  }

  // DELETE /api/events/:eventId/pricing/rules/:ruleId — 204 (bare, no envelope)
  @Delete(":eventId/pricing/rules/:ruleId")
  @EventScoped({ module: "pricing", write: true })
  @HttpCode(204)
  @SkipEnvelope()
  async deleteRule(
    @Param() { eventId, ruleId }: RuleIdParamDto,
  ): Promise<void> {
    await this.pricing.deletePricingRule(eventId, ruleId);
  }
}
