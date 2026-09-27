import * as responses from "@app/contracts";
import { ResponseContract } from "../../core/response-contract";
import { EventScoped } from "../tenancy/tenant-scope";
import { Auth } from "../../core/auth/auth.decorator";

import { getConfig } from "../../core/config";

import {
  Controller,
  Get,
  Headers,
  Ip,
  Param,
  Post,
} from "@nestjs/common";
import {
  getNetworkingEmbeddingHealth,
  reindexNetworkingEvent,
} from "@app/db";
import { NetworkingService } from "./networking.service";
import { NetworkingRecommendationsService } from "./networking-recommendations.service";


@Controller("api/networking/:slug")
export class NetworkingRecommendationsController {
  constructor(
    private readonly networking: NetworkingService,
    private readonly recommendationsService: NetworkingRecommendationsService,
  ) {}

  @ResponseContract(responses.NetworkingRecommendationRecommendationsResponseSchema)
  @Get("recommendations")
  async recommendations(
    @Param("slug") slug: string,
    @Ip() ip: string,
    @Headers("authorization") authorization?: string,
  ) {
    const ctx = await this.networking.participant(slug, authorization, { ip });
    return this.recommendationsService.recommendations(ctx);
  }
}

@Auth()
@Controller("api/events/:eventId/networking/recommendations")
export class NetworkingRecommendationAdminController {

  @ResponseContract(responses.NetworkingRecommendationAdminStatusResponseSchema)
  @EventScoped({ module: "networking" })
  @Get("status")
  async status(
    @Param("eventId") eventId: string,
  ) {
    return {
      configured: Boolean(getConfig().networking.embedding.apiKey),
      model: getConfig().networking.embedding.model,
      dimensions: 1536,
      jobs: await getNetworkingEmbeddingHealth(eventId),
    };
  }
  @ResponseContract(responses.NetworkingRecommendationAdminReindexResponseSchema)
  @EventScoped({ module: "networking", write: true })
  @Post("reindex")
  async reindex(
    @Param("eventId") eventId: string,
  ) {
    return { queued: await reindexNetworkingEvent(eventId) };
  }
}
