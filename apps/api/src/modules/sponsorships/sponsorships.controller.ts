import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ErrorCodes } from "@app/contracts";
import {
  assertClientModuleEnabled,
} from "../clients/module-gates";
import {
  getEventWithPricing,
  getRegistrationForSponsorship,
} from "@app/db";
import { Auth } from "../../core/auth/auth.decorator";
import { CurrentUser } from "../../core/auth/current-user.decorator";
import { canAccessClient, type AuthUser } from "../../core/auth/user-cache";
import { assertEventWritable } from "../events";
import { AppException, forbidden } from "../../core/app-exception";
import { SponsorshipsService } from "./sponsorships.service";
import {
  ListSponsorshipsQueryDto,
  LinkSponsorshipByCodeDto,
  LinkSponsorshipDto,
  RegistrationIdParamDto,
  RegistrationSponsorshipParamDto,
  SponsorshipEventIdParamDto,
  SponsorshipIdParamDto,
  UpdateSponsorshipDto,
} from "./dto";

// ============================================================================
// Event-scoped list — GET /api/events/:eventId/sponsorships (no module gate)
// ============================================================================

@Controller("api/events")
@Auth()
export class SponsorshipsListController {
  constructor(private readonly service: SponsorshipsService) {}

  @Get(":eventId/sponsorships")
  async list(
    @Param() { eventId }: SponsorshipEventIdParamDto,
    @Query() query: ListSponsorshipsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    const event = await getEventWithPricing(eventId);
    if (!event) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }
    if (!canAccessClient(user, event.clientId)) forbidden();
    return this.service.listSponsorships(eventId, query);
  }
}

// ============================================================================
// Detail — /api/sponsorships/:id
// ============================================================================

@Controller("api/sponsorships")
@Auth()
export class SponsorshipDetailController {
  constructor(private readonly service: SponsorshipsService) {}

  // GET detail — no module gate.
  @Get(":id")
  async detail(
    @Param() { id }: SponsorshipIdParamDto,
    @CurrentUser() user: AuthUser,
  ) {
    const sponsorship = await this.service.getSponsorshipById(id);
    if (!sponsorship) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Sponsorship not found", 404);
    }
    if (!canAccessClient(user, sponsorship.event.clientId)) forbidden();
    return sponsorship;
  }

  // PATCH — status:"CANCELLED" detours to cancel (service handles it).
  @Patch(":id")
  async update(
    @Param() { id }: SponsorshipIdParamDto,
    @Body() body: UpdateSponsorshipDto,
    @CurrentUser() user: AuthUser,
  ) {
    const clientId = await this.service.getSponsorshipClientId(id);
    if (!clientId) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Sponsorship not found", 404);
    }
    if (!canAccessClient(user, clientId)) forbidden();
    await assertClientModuleEnabled(clientId, "sponsorships");
    return this.service.updateSponsorship(id, body, user.id);
  }

  @Delete(":id")
  async remove(
    @Param() { id }: SponsorshipIdParamDto,
    @CurrentUser() user: AuthUser,
  ) {
    const clientId = await this.service.getSponsorshipClientId(id);
    if (!clientId) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Sponsorship not found", 404);
    }
    if (!canAccessClient(user, clientId)) forbidden();
    await assertClientModuleEnabled(clientId, "sponsorships");
    await this.service.deleteSponsorship(id, user.id);
    return { success: true };
  }
}

// ============================================================================
// Registration-scoped — /api/registrations/:registrationId/...
// ============================================================================

@Controller("api/registrations")
@Auth()
export class RegistrationSponsorshipsController {
  constructor(private readonly service: SponsorshipsService) {}

  @Get(":registrationId/available-sponsorships")
  async available(
    @Param() { registrationId }: RegistrationIdParamDto,
    @CurrentUser() user: AuthUser,
  ) {
    const registration = await this.requireRegistration(registrationId, user);
    const sponsorships = await this.service.getAvailableSponsorships(
      registration.event.id,
      registrationId,
    );
    return { sponsorships };
  }

  @Get(":registrationId/sponsorships")
  async linked(
    @Param() { registrationId }: RegistrationIdParamDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.requireRegistration(registrationId, user);
    return this.service.getLinkedSponsorships(registrationId);
  }

  @Post(":registrationId/sponsorships")
  @HttpCode(201)
  async link(
    @Param() { registrationId }: RegistrationIdParamDto,
    @Body() { sponsorshipId }: LinkSponsorshipDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.requireWritableRegistration(registrationId, user);
    const result = await this.service.linkSponsorshipToRegistration(
      sponsorshipId,
      registrationId,
      user.id,
    );
    return { success: true, ...result };
  }

  @Post(":registrationId/sponsorships/by-code")
  @HttpCode(201)
  async linkByCode(
    @Param() { registrationId }: RegistrationIdParamDto,
    @Body() { code }: LinkSponsorshipByCodeDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.requireWritableRegistration(registrationId, user);
    const result = await this.service.linkSponsorshipByCode(
      registrationId,
      code,
      user.id,
    );
    return { success: true, ...result };
  }

  @Delete(":registrationId/sponsorships/:sponsorshipId")
  async unlink(
    @Param() { registrationId, sponsorshipId }: RegistrationSponsorshipParamDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.requireWritableRegistration(registrationId, user);
    await this.service.unlinkSponsorshipFromRegistration(
      sponsorshipId,
      registrationId,
      user.id,
    );
    return { success: true };
  }

  /** Route guard: registration exists + tenant access. */
  private async requireRegistration(registrationId: string, user: AuthUser) {
    const registration = await getRegistrationForSponsorship(registrationId);
    if (!registration) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Registration not found",
        404,
      );
    }
    if (!canAccessClient(user, registration.event.clientId)) forbidden();
    return registration;
  }

  /** Mutation guard: + event writable + module gate (mirrors legacy). */
  private async requireWritableRegistration(
    registrationId: string,
    user: AuthUser,
  ) {
    const registration = await this.requireRegistration(registrationId, user);
    const event = await getEventWithPricing(registration.event.id);
    if (!event) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }
    assertEventWritable(event);
    await assertClientModuleEnabled(event.clientId, "sponsorships");
    return registration;
  }
}
