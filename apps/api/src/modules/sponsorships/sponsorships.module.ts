import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import {
  RegistrationSponsorshipsController,
  SponsorshipDetailController,
  SponsorshipsListController,
} from "./sponsorships.controller";
import { SponsorshipsPublicController } from "./sponsorships.public.controller";
import { SponsorshipsService } from "./sponsorships.service";

@Module({
  imports: [AccessModule],
  controllers: [
    SponsorshipsListController,
    SponsorshipDetailController,
    RegistrationSponsorshipsController,
    SponsorshipsPublicController,
  ],
  providers: [SponsorshipsService],
  // Exported so the registrations module (wave-3) can inject the link/unlink/
  // recalc helpers and run them inside its own transaction.
  exports: [SponsorshipsService],
})
export class SponsorshipsModule {}
