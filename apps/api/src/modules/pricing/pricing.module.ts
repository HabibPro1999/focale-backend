import { Module } from "@nestjs/common";
import { PricingController } from "./pricing.controller";
import { PricingPublicController } from "./pricing.public.controller";
import { PricingService } from "./pricing.service";

@Module({
  controllers: [PricingController, PricingPublicController],
  providers: [PricingService],
  // Exported so the registrations module can inject PricingService.calculatePrice.
  exports: [PricingService],
})
export class PricingModule {}
