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
import {
  AvailableSponsorshipsResponseSchema,
  ErrorCodes,
  LinkedSponsorshipsResponseSchema,
  SponsorshipDetailResponseSchema,
  SponsorshipLinkedResponseSchema,
  SponsorshipListResponseSchema,
  SponsorshipSuccessResponseSchema,
} from "@app/contracts";
import type { ScopedEventRow } from "@app/db";
import { Auth } from "../../core/auth/auth.decorator";
import { CurrentUser } from "../../core/auth/current-user.decorator";
import { type AuthUser } from "../../core/auth/user-cache";
import { AppException } from "../../core/app-exception";
import {
  EventScoped,
  RegistrationScoped,
  ScopedEvent,
  SponsorshipScoped,
} from "../tenancy";
import { ResponseContract } from "../../core/response-contract";
import { SponsorshipsAdminService } from "./sponsorships.admin.service";
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
  constructor(private readonly service: SponsorshipsAdminService) {}

  @Get(":eventId/sponsorships")
  @EventScoped()
  @ResponseContract(SponsorshipListResponseSchema)
  async list(
    @Param() { eventId }: SponsorshipEventIdParamDto,
    @Query() query: ListSponsorshipsQueryDto,
  ) {
    return this.service.listSponsorships(eventId, query);
  }
}

// ============================================================================
// Detail — /api/sponsorships/:id
// ============================================================================

@Controller("api/sponsorships")
@Auth()
export class SponsorshipDetailController {
  constructor(private readonly service: SponsorshipsAdminService) {}

  // GET detail — no module gate.
  @Get(":id")
  @SponsorshipScoped()
  @ResponseContract(SponsorshipDetailResponseSchema)
  async detail(@Param() { id }: SponsorshipIdParamDto) {
    const sponsorship = await this.service.getSponsorshipById(id);
    if (!sponsorship) {
      // Deleted between the scope guard and this read.
      throw new AppException(ErrorCodes.NOT_FOUND, "Sponsorship not found", 404);
    }
    return sponsorship;
  }

  // PATCH — status:"CANCELLED" detours to cancel (service handles it).
  @Patch(":id")
  @SponsorshipScoped({ module: "sponsorships" })
  @ResponseContract(SponsorshipDetailResponseSchema)
  async update(
    @Param() { id }: SponsorshipIdParamDto,
    @Body() body: UpdateSponsorshipDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.updateSponsorship(id, body, user.id);
  }

  @Delete(":id")
  @SponsorshipScoped({ module: "sponsorships" })
  @ResponseContract(SponsorshipSuccessResponseSchema)
  async remove(
    @Param() { id }: SponsorshipIdParamDto,
    @CurrentUser() user: AuthUser,
  ) {
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
  constructor(private readonly service: SponsorshipsAdminService) {}

  @Get(":registrationId/available-sponsorships")
  @RegistrationScoped({ param: "registrationId" })
  @ResponseContract(AvailableSponsorshipsResponseSchema)
  async available(
    @Param() { registrationId }: RegistrationIdParamDto,
    @ScopedEvent() event: ScopedEventRow,
  ) {
    const sponsorships = await this.service.getAvailableSponsorships(
      event.id,
      registrationId,
    );
    return { sponsorships };
  }

  @Get(":registrationId/sponsorships")
  @RegistrationScoped({ param: "registrationId" })
  @ResponseContract(LinkedSponsorshipsResponseSchema)
  async linked(@Param() { registrationId }: RegistrationIdParamDto) {
    return this.service.getLinkedSponsorships(registrationId);
  }

  @Post(":registrationId/sponsorships")
  @RegistrationScoped({ param: "registrationId", module: "sponsorships", write: true })
  @HttpCode(201)
  @ResponseContract(SponsorshipLinkedResponseSchema)
  async link(
    @Param() { registrationId }: RegistrationIdParamDto,
    @Body() { sponsorshipId }: LinkSponsorshipDto,
    @CurrentUser() user: AuthUser,
  ) {
    const result = await this.service.linkSponsorshipToRegistration(
      sponsorshipId,
      registrationId,
      user.id,
    );
    return { success: true, ...result };
  }

  @Post(":registrationId/sponsorships/by-code")
  @RegistrationScoped({ param: "registrationId", module: "sponsorships", write: true })
  @HttpCode(201)
  @ResponseContract(SponsorshipLinkedResponseSchema)
  async linkByCode(
    @Param() { registrationId }: RegistrationIdParamDto,
    @Body() { code }: LinkSponsorshipByCodeDto,
    @CurrentUser() user: AuthUser,
  ) {
    const result = await this.service.linkSponsorshipByCode(
      registrationId,
      code,
      user.id,
    );
    return { success: true, ...result };
  }

  @Delete(":registrationId/sponsorships/:sponsorshipId")
  @RegistrationScoped({ param: "registrationId", module: "sponsorships", write: true })
  @ResponseContract(SponsorshipSuccessResponseSchema)
  async unlink(
    @Param() { registrationId, sponsorshipId }: RegistrationSponsorshipParamDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.service.unlinkSponsorshipFromRegistration(
      sponsorshipId,
      registrationId,
      user.id,
    );
    return { success: true };
  }
}
