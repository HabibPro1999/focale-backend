import { NetworkingRecommendationsService } from "./networking-recommendations.service";
import { NetworkingNotificationsService } from "./networking.notifications.service";
import { NetworkingInventoryService } from "./networking.inventory.service";
import { NetworkingMfaService } from "./networking.mfa.service";
import { NetworkingMfaController } from "./networking.mfa.controller";
import { NetworkingUploadsService } from "./networking.uploads.service";
import { Module } from "@nestjs/common";
import { NetworkingService } from "./networking.service";
import { NetworkingSocialService } from "./networking.social.service";
import { NetworkingMeetingsService } from "./networking.meetings.service";
import { NetworkingAdminService } from "./networking.admin.service";
import { NetworkingExportsService } from "./networking.exports.service";
import { NetworkingPublicController } from "./networking.public.controller";
import { NetworkingStreamController } from "./networking.stream.controller";
import { NetworkingStreamService } from "./networking.stream";
import { NetworkingAdminController } from "./networking.admin.controller";
import { NetworkingRecommendationsController, NetworkingRecommendationAdminController } from "./networking-recommendations.controller";
@Module({
  controllers: [
    NetworkingMfaController,
    NetworkingPublicController,
    NetworkingStreamController,
    NetworkingAdminController,
    NetworkingRecommendationsController,
    NetworkingRecommendationAdminController,
  ],
  providers: [
    NetworkingInventoryService,
    NetworkingMfaService,
    NetworkingUploadsService,
    NetworkingService,
    NetworkingSocialService,
    NetworkingMeetingsService,
    NetworkingAdminService,
    NetworkingExportsService,
    NetworkingStreamService,
    NetworkingNotificationsService,
    NetworkingRecommendationsService,
  ],
})
export class NetworkingModule {}
