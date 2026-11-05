import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  ErrorCodes,
  getSponsorshipSettings,
  PublicRegistrantSearchResponseSchema,
  SponsorshipBatchCreatedResponseSchema,
  SponsorshipCodeRedeemedResponseSchema,
} from "@app/contracts";
import { getEventWithPricing, getEventWithPricingBySlug } from "@app/db";
import { assertClientModuleEnabled } from "../clients/module-gates";
import { assertEventAcceptsPublicActions } from "../events";
import { AppException, notFound } from "../../core/app-exception";
import { ResponseContract } from "../../core/response-contract";
import { requireRegistrationEditToken } from "../registrations/edit-token";
import { EditTokenQueryDto } from "../registrations/registrations.dto";
import { SponsorshipsPublicService } from "./sponsorships.public.service";
import {
  CreateSponsorshipBatchDto,
  RedeemSponsorshipCodeDto,
  RegistrationIdParamDto,
  RegistrantSearchQueryDto,
  SponsorshipEventIdParamDto,
  SponsorshipEventSlugParamDto,
} from "./dto";

// Legacy publicRateLimits.registration = 5 / minute.
const BATCH_THROTTLE = { default: { limit: 5, ttl: 60_000 } };
// Hardcoded 10 / minute on the registrant-search route.
const SEARCH_THROTTLE = { default: { limit: 10, ttl: 60_000 } };
// A code is guessable input: 5 tries / minute, as the edit-token routes allow few.
const REDEEM_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

@Controller("api/public/events")
export class SponsorshipsPublicController {
  constructor(private readonly service: SponsorshipsPublicService) {}

  // POST /api/public/events/:eventId/sponsorships
  @Post(":eventId/sponsorships")
  @HttpCode(201)
  @Throttle(BATCH_THROTTLE)
  @ResponseContract(SponsorshipBatchCreatedResponseSchema)
  async createByEventId(
    @Param() { eventId }: SponsorshipEventIdParamDto,
    @Body() input: CreateSponsorshipBatchDto,
  ) {
    const event = await getEventWithPricing(eventId);
    if (!event) {
      throw notFound("Event not found");
    }
    return this.createForEvent(event, eventId, input);
  }

  // GET /api/public/events/slug/:slug/registrants/search
  @Get("slug/:slug/registrants/search")
  @Throttle(SEARCH_THROTTLE)
  @ResponseContract(PublicRegistrantSearchResponseSchema)
  async searchRegistrants(
    @Param() { slug }: SponsorshipEventSlugParamDto,
    @Query() { query, unpaidOnly }: RegistrantSearchQueryDto,
  ) {
    const event = await getEventWithPricingBySlug(slug);
    if (!event) {
      throw notFound("Event not found");
    }
    assertEventAcceptsPublicActions(event);
    await assertClientModuleEnabled(event.clientId, "sponsorships");

    const form = await this.service.getActiveSponsorForm(event.id);
    if (!form) {
      throw notFound("Sponsor form not found");
    }

    const settings = getSponsorshipSettings(form.schema);
    if (settings?.sponsorshipMode !== "LINKED_ACCOUNT") {
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

    // Anonymous caller: the service masks the email and returns no contact
    // details or form answers.
    return this.service.searchRegistrants(event.id, {
      query,
      unpaidOnly: effectiveUnpaidOnly,
      limit: 10,
    });
  }

  // POST /api/public/events/slug/:slug/sponsorships
  @Post("slug/:slug/sponsorships")
  @HttpCode(201)
  @Throttle(BATCH_THROTTLE)
  @ResponseContract(SponsorshipBatchCreatedResponseSchema)
  async createBySlug(
    @Param() { slug }: SponsorshipEventSlugParamDto,
    @Body() input: CreateSponsorshipBatchDto,
  ) {
    const event = await getEventWithPricingBySlug(slug);
    if (!event) {
      throw notFound("Event not found");
    }
    return this.createForEvent(event, event.id, input);
  }

  private async createForEvent(
    event: NonNullable<Awaited<ReturnType<typeof getEventWithPricing>>>,
    eventId: string,
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

// A registrant redeems a sponsorship code on their own registration from the
// payment page. Self-service like the registration edit routes: the 64-hex
// edit token via X-Edit-Token header or ?token=.
@Controller("api/public/registrations")
export class SponsorshipCodePublicController {
  constructor(private readonly service: SponsorshipsPublicService) {}

  // POST /api/public/registrations/:registrationId/sponsorship-code
  @Post(":registrationId/sponsorship-code")
  @HttpCode(200)
  @Throttle(REDEEM_THROTTLE)
  @ResponseContract(SponsorshipCodeRedeemedResponseSchema)
  async redeem(
    @Param() { registrationId }: RegistrationIdParamDto,
    @Query() { token }: EditTokenQueryDto,
    @Body() { code }: RedeemSponsorshipCodeDto,
    @Headers("x-edit-token") headerToken?: string,
  ) {
    await requireRegistrationEditToken(registrationId, headerToken, token);
    const registration = await this.service.redeemSponsorshipCode(registrationId, code);
    return { success: true as const, registration };
  }
}
