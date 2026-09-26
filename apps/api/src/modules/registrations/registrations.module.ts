import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { PricingModule } from "../pricing/pricing.module";
import { RegistrationsService } from "./registrations.service";
import { RegistrationSideEffects } from "./registrations.side-effects";
import {
  RegistrationEditLinkController,
  RegistrationsController,
} from "./registrations.controller";
import {
  RegistrationsPublicController,
  RegistrationEditPublicController,
} from "./registrations.public.controller";

@Module({
  imports: [AccessModule, PricingModule],
  controllers: [
    RegistrationsController,
    RegistrationEditLinkController,
    RegistrationsPublicController,
    RegistrationEditPublicController,
  ],
  providers: [RegistrationsService, RegistrationSideEffects],
  // Exported so certificates/reports/sponsorships can consume registration reads.
  exports: [RegistrationsService],
})
export class RegistrationsModule {}
