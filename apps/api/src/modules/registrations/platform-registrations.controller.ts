import { PlatformRegistrationsQueryDto } from "./registrations.dto";
import { Controller, Get, Query } from "@nestjs/common";
import { PlatformRegistrationAggregateResponseSchema, PlatformRegistrationsResponseSchema, UserRole } from "@app/contracts";
import { Auth } from "../../core/auth/auth.decorator";
import { ResponseContract } from "../../core/response-contract";
import { RegistrationsService } from "./registrations.service";

@Controller("api/registrations")
@Auth(UserRole.SUPER_ADMIN)
export class PlatformRegistrationsController {
  constructor(private readonly registrations: RegistrationsService) {}

  @Get()
  @ResponseContract(PlatformRegistrationsResponseSchema)
  list(@Query() query: PlatformRegistrationsQueryDto) { return this.registrations.platformList(query); }

  @Get("aggregate")
  @ResponseContract(PlatformRegistrationAggregateResponseSchema)
  aggregate() { return this.registrations.platformAggregate(); }
}
