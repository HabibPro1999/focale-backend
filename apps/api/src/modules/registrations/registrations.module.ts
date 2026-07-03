import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { PricingModule } from "../pricing/pricing.module";
import { RegistrationsService } from "./registrations.service";
import { RegistrationsController } from "./registrations.controller";
import {
  RegistrationsPublicController,
  RegistrationEditPublicController,
} from "./registrations.public.controller";

@Module({
  imports: [AccessModule, PricingModule],
  controllers: [
    RegistrationsController,
    RegistrationsPublicController,
    RegistrationEditPublicController,
  ],
  providers: [RegistrationsService],
  // Exported so certificates/reports/sponsorships can consume registration reads.
  exports: [RegistrationsService],
})
export class RegistrationsModule {}
