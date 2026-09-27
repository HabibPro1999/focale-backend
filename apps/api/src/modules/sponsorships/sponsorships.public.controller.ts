import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ErrorCodes, getSponsorshipMode, getSponsorshipSettings } from "@app/contracts";
import { getEventWithPricing, getEventWithPricingBySlug } from "@app/db";
import { maskEmail } from "@app/shared";
import { assertClientModuleEnabled } from "../clients/module-gates";
import { assertEventAcceptsPublicActions } from "../events";
import { AppException, notFound, orNotFound } from "../../core/app-exception";
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
    const event = orNotFound(await getEventWithPricing(eventId), "Event not found");

    return this.createBatch(eventId, event, input);
  }

  // GET /api/public/events/slug/:slug/registrants/search
  @Get("slug/:slug/registrants/search")
  @Throttle(SEARCH_THROTTLE)
  async searchRegistrants(
    @Param() { slug }: SponsorshipEventSlugParamDto,
    @Query() { query, unpaidOnly }: RegistrantSearchQueryDto,
  ) {
    const event = orNotFound(await getEventWithPricingBySlug(slug), "Event not found");

    assertEventAcceptsPublicActions(event);
    await assertClientModuleEnabled(event.clientId, "sponsorships");

    const form = await this.service.getActiveSponsorForm(event.id);
    if (!form) {
      throw notFound("Sponsor form not found");
    }

    const settings = getSponsorshipSettings(form.schema);
    if (getSponsorshipMode(form.schema) !== "LINKED_ACCOUNT") {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        "Search not available for this form",
        403,
      );
    }

    // Server-forced scope: UNPAID_ONLY overrides the client's query param.
    const scope = settings.registrantSearchScope ?? "ALL";
    const effectiveUnpaidOnly =
      scope === "UNPAID_ONLY" ? true : unpaidOnly === "true";

    const results = await this.service.searchRegistrantsForSponsorship(event.id, {
      query,
      unpaidOnly: effectiveUnpaidOnly,
      limit: 10,
    });

    // Anonymous caller: strip phone + formData and mask the email.
    return results.map(({ phone: _phone, formData: _formData, ...safe }) => ({
      ...safe,
      email: maskEmail(safe.email),
    }));
  }

  // POST /api/public/events/slug/:slug/sponsorships
  @Post("slug/:slug/sponsorships")
  @HttpCode(201)
  @Throttle(BATCH_THROTTLE)
  async createBySlug(
    @Param() { slug }: SponsorshipEventSlugParamDto,
    @Body() input: CreateSponsorshipBatchDto,
  ) {
    const event = orNotFound(await getEventWithPricingBySlug(slug), "Event not found");

    return this.createBatch(event.id, event, input);
  }

  private async createBatch(
    eventId: string,
    event: NonNullable<Awaited<ReturnType<typeof getEventWithPricing>>>,
    input: CreateSponsorshipBatchDto,
  ) {
    assertEventAcceptsPublicActions(event);
    await assertClientModuleEnabled(event.clientId, "sponsorships");

    const form = await this.service.getActiveSponsorForm(eventId);
    if (!form) {
      throw notFound("Sponsor form not found for this event");
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
}
