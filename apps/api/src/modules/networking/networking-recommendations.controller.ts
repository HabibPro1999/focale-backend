import { NetworkingRecommendationsService } from "./networking.recommendations.service";
import { networkingOrganizerAccess } from "./networking.organizer-access";

import { Auth } from "../../core/auth/auth.decorator";
import { CurrentUser } from "../../core/auth/current-user.decorator";
import type { AuthUser } from "../../core/auth/user-cache";
import { getConfig } from "../../core/config";
import { Controller, Get, Headers, Ip, Param, Post } from "@nestjs/common";
import { getNetworkingEmbeddingHealth, reindexNetworkingEvent } from "@app/db";
import { NetworkingService } from "./networking.service";


@Controller("api/networking/:slug")
export class NetworkingRecommendationsController {
  constructor(private readonly networking: NetworkingService, private readonly ranking: NetworkingRecommendationsService) {}

  @Get("recommendations")
  async recommendations(
    @Param("slug") slug: string,
    @Ip() ip: string,
    @Headers("authorization") authorization?: string,
  ) {
    const ctx = await this.networking.participant(slug, authorization, { ip });
    return this.ranking.recommendations(ctx);
  }
}

@Auth()
@Controller("api/events/:eventId/networking/recommendations")
export class NetworkingRecommendationAdminController {

  @Get("status")
  async status(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
  ) {
    await networkingOrganizerAccess(user, eventId);
    return {
      configured: Boolean(getConfig().networking.embedding.apiKey),
      model: getConfig().networking.embedding.model,
      dimensions: 1536,
      jobs: await getNetworkingEmbeddingHealth(eventId),
    };
  }
  @Post("reindex")
  async reindex(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
  ) {
    await networkingOrganizerAccess(user, eventId, true);
    return { queued: await reindexNetworkingEvent(eventId) };
  }
}
