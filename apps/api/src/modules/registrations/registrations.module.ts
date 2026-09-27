import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { PricingModule } from "../pricing/pricing.module";
import { RegistrationsReadService } from "./registrations.read.service";
import { RegistrationsCreateService } from "./registrations.create.service";
import { RegistrationsAdminService } from "./registrations.admin.service";
import { RegistrationSelfService } from "./registration-self.service";
import { RegistrationPaymentProofService } from "./registration-payment-proof.service";
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
  providers: [RegistrationsReadService, RegistrationsCreateService, RegistrationsAdminService, RegistrationSelfService, RegistrationPaymentProofService],
})
export class RegistrationsModule {}
