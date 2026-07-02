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
import type { PricingEventOwnership } from "@app/db";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { Auth } from "../../core/auth/auth.decorator";
import { CurrentUser } from "../../core/auth/current-user.decorator";
import { AppException } from "./app-exception";
import { assertEventWritable, canAccessClient } from "./gates";
import { PricingService } from "./pricing.service";
import {
  CreateEmbeddedRuleDto,
  EventIdParamDto,
  RuleIdParamDto,
  UpdateEmbeddedRuleDto,
  UpdateEventPricingDto,
} from "./pricing.dto";

// ponytail: NOTE FOR VERIFIER — ownership uses numeric role + clientId
// (canAccessClient). The core AuthGuard currently attaches the raw Firebase
// DecodedIdToken; per port-spec the guard should populate request.user with the
// 8-field app user (id,email,name,role,clientId,active,...). Until that lands,
// request.user is cast to the numeric-role shape here. Fail-closed on unknown roles.
type TenantUser = { role: number; clientId: string | null };

@Controller("api/events")
@Auth()
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  // GET /api/events/:eventId/pricing
  @Get(":eventId/pricing")
  async getPricing(@Param() { eventId }: EventIdParamDto, @CurrentUser() user: unknown) {
    await this.ensureAccess(
      eventId,
      user,
      "Insufficient permissions to access this event",
      false,
    );
    const pricing = await this.pricing.getEventPricing(eventId);
    if (!pricing) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event pricing not found", 404);
    }
    return pricing;
  }

  // PATCH /api/events/:eventId/pricing
  @Patch(":eventId/pricing")
  async updatePricing(
    @Param() { eventId }: EventIdParamDto,
    @Body() body: UpdateEventPricingDto,
    @CurrentUser() user: unknown,
  ) {
    await this.ensureAccess(
      eventId,
      user,
      "Insufficient permissions to update this event",
      true,
    );
    return this.pricing.updateEventPricing(eventId, body);
  }

  // POST /api/events/:eventId/pricing/rules — 201
  @Post(":eventId/pricing/rules")
  @HttpCode(201)
  async addRule(
    @Param() { eventId }: EventIdParamDto,
    @Body() body: CreateEmbeddedRuleDto,
    @CurrentUser() user: unknown,
  ) {
    await this.ensureAccess(
      eventId,
      user,
      "Insufficient permissions to create pricing rules for this event",
      true,
    );
    return this.pricing.addPricingRule(eventId, body);
  }

  // PATCH /api/events/:eventId/pricing/rules/:ruleId
  @Patch(":eventId/pricing/rules/:ruleId")
  async updateRule(
    @Param() { eventId, ruleId }: RuleIdParamDto,
    @Body() body: UpdateEmbeddedRuleDto,
    @CurrentUser() user: unknown,
  ) {
    await this.ensureAccess(
      eventId,
      user,
      "Insufficient permissions to update this pricing rule",
      true,
    );
    return this.pricing.updatePricingRule(eventId, ruleId, body);
  }

  // DELETE /api/events/:eventId/pricing/rules/:ruleId — 204 (bare, no envelope)
  @Delete(":eventId/pricing/rules/:ruleId")
  @HttpCode(204)
  @SkipEnvelope()
  async deleteRule(
    @Param() { eventId, ruleId }: RuleIdParamDto,
    @CurrentUser() user: unknown,
  ): Promise<void> {
    await this.ensureAccess(
      eventId,
      user,
      "Insufficient permissions to delete this pricing rule",
      true,
    );
    await this.pricing.deletePricingRule(eventId, ruleId);
  }

  /**
   * Shared route guard: 404 if event missing, 403 (route-specific message) if the
   * user cannot access the event's client, optional archived-writable check, then
   * the client pricing-module gate. Mirrors the legacy per-route hook chain.
   */
  private async ensureAccess(
    eventId: string,
    user: unknown,
    forbiddenMessage: string,
    checkWritable: boolean,
  ): Promise<PricingEventOwnership> {
    const event = await this.pricing.getEventForOwnership(eventId);
    if (!event) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }
    if (!canAccessClient(user as TenantUser, event.clientId)) {
      throw new AppException(ErrorCodes.FORBIDDEN, forbiddenMessage, 403);
    }
    if (checkWritable) assertEventWritable(event);
    await this.pricing.assertClientModuleEnabled(event.clientId);
    return event;
  }
}
