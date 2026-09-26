import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import {
  RegistrationSponsorshipsController,
  SponsorshipDetailController,
  SponsorshipsListController,
} from "./sponsorships.controller";
import { SponsorshipsPublicController } from "./sponsorships.public.controller";
import { SponsorshipsAdminService } from "./sponsorships.admin.service";
import { SponsorshipsPublicService } from "./sponsorships.public.service";

// Split by trust level (plan 5.7): the authenticated controllers inject
// SponsorshipsAdminService; the anonymous one injects SponsorshipsPublicService
// only.
@Module({
  imports: [AccessModule],
  controllers: [
    SponsorshipsListController,
    SponsorshipDetailController,
    RegistrationSponsorshipsController,
    SponsorshipsPublicController,
  ],
  providers: [SponsorshipsAdminService, SponsorshipsPublicService],
})
export class SponsorshipsModule {}
