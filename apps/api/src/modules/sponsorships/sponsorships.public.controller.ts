import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ErrorCodes } from "@app/contracts";
import { getEventWithPricing, getEventWithPricingBySlug } from "@app/db";
import { assertClientModuleEnabled } from "../clients/module-gates";
import { assertEventAcceptsPublicActions } from "../events";
import { AppException } from "./app-exception";
import { SponsorshipsService } from "./sponsorships.service";
import {
  CreateSponsorshipBatchDto,
  RegistrantSearchQueryDto,
  SponsorshipEventIdParamDto,
  SponsorshipEventSlugParamDto,
} from "./dto";

// Legacy publicRateLimits.registration = 5 / minute.
const BATCH_THROTTLE = { default: { limit: 5, ttl: 60_000 } };
// Hardcoded 10 / minute on the registrant-search route.
const SEARCH_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

@Controller("api/public/events")
export class SponsorshipsPublicController {
  constructor(private readonly service: SponsorshipsService) {}

  // POST /api/public/events/:eventId/sponsorships
  @Post(":eventId/sponsorships")
  @HttpCode(201)
  @Throttle(BATCH_THROTTLE)
  async createByEventId(
    @Param() { eventId }: SponsorshipEventIdParamDto,
    @Body() input: CreateSponsorshipBatchDto,
  ) {
    const event = await getEventWithPricing(eventId);
    if (!event) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }
    assertEventAcceptsPublicActions(event);
    await assertClientModuleEnabled(event.clientId, "sponsorships");

    const form = await this.service.getActiveSponsorForm(eventId);
    if (!form) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Sponsor form not found for this event",
        404,
      );
    }
    const result = await this.service.createSponsorshipBatch(
      eventId,
      form.id,
      input,
    );
    return {
      success: true,
      message: `${result.count} sponsoring(s) created successfully`,
      batchId: result.batchId,
      count: result.count,
    };
  }

  // GET /api/public/events/slug/:slug/registrants/search
  @Get("slug/:slug/registrants/search")
  @Throttle(SEARCH_THROTTLE)
  async searchRegistrants(
    @Param() { slug }: SponsorshipEventSlugParamDto,
    @Query() { query, unpaidOnly }: RegistrantSearchQueryDto,
  ) {
    const event = await getEventWithPricingBySlug(slug);
    if (!event) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }
    assertEventAcceptsPublicActions(event);
    await assertClientModuleEnabled(event.clientId, "sponsorships");

    const form = await this.service.getActiveSponsorForm(event.id);
    if (!form) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Sponsor form not found", 404);
    }

    const schema = form.schema as Record<string, unknown> | null;
    const settings = schema?.sponsorshipSettings as
      | Record<string, unknown>
      | undefined;
    if (settings?.sponsorshipMode !== "LINKED_ACCOUNT") {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        "Search not available for this form",
        403,
      );
    }

    // Server-forced scope: UNPAID_ONLY overrides the client's query param.
    const scope = (settings?.registrantSearchScope as string | undefined) ?? "ALL";
    const effectiveUnpaidOnly =
      scope === "UNPAID_ONLY" ? true : unpaidOnly === "true";

    const results = await this.service.searchRegistrantsForSponsorship(event.id, {
      query,
      unpaidOnly: effectiveUnpaidOnly,
      limit: 10,
    });

    // Strip phone + formData from every result.
    return results.map(({ phone: _phone, formData: _formData, ...safe }) => safe);
  }

  // POST /api/public/events/slug/:slug/sponsorships
  @Post("slug/:slug/sponsorships")
  @HttpCode(201)
  @Throttle(BATCH_THROTTLE)
  async createBySlug(
    @Param() { slug }: SponsorshipEventSlugParamDto,
    @Body() input: CreateSponsorshipBatchDto,
  ) {
    const event = await getEventWithPricingBySlug(slug);
    if (!event) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }
    assertEventAcceptsPublicActions(event);
    await assertClientModuleEnabled(event.clientId, "sponsorships");

    const form = await this.service.getActiveSponsorForm(event.id);
    if (!form) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Sponsor form not found for this event",
        404,
      );
    }
    const result = await this.service.createSponsorshipBatch(
      event.id,
      form.id,
      input,
    );
    return {
      success: true,
      message: `${result.count} sponsoring(s) created successfully`,
      batchId: result.batchId,
      count: result.count,
    };
  }
}
