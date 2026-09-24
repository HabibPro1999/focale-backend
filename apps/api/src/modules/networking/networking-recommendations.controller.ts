import { Auth } from "../../core/auth/auth.decorator";
import { CurrentUser } from "../../core/auth/current-user.decorator";
import type { AuthUser } from "../../core/auth/user-cache";
import { assertEventAccess } from "../../core/auth/assert-event-access";
import { assertClientModuleEnabled } from "../clients/module-gates";
import { assertEventWritable } from "../events/events.service";
import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Ip,
  Param,
  Post,
} from "@nestjs/common";
import {
  findNetworkingVectorCandidates,
  getNetworkingRecommendationProfiles,
  getNetworkingEmbeddingHealth,
  reindexNetworkingEvent,
} from "@app/db";
import { NetworkingService } from "./networking.service";
import { networkingPublicProfile } from "./networking.policy";

import { profileEmbeddingInput } from "@app/integrations";
import { NetworkingRecommendationCache } from "./networking-recommendation-cache";

const reasons = {
  fr: {
    needs: "Son offre correspond à vos recherches",
    offers: "Votre offre correspond à ses recherches",
    background: "Domaines professionnels et intérêts proches",
    featured: "Exposant mis en avant par l’organisateur",
  },
  en: {
    needs: "Their offering relates to what you’re looking for",
    offers: "Your offering relates to what they’re looking for",
    background: "Related professional interests and background",
    featured: "Exhibitor featured by the organizer",
  },
  ar: {
    needs: "ما يقدّمه يتوافق مع ما تبحث عنه",
    offers: "ما تقدّمه يتوافق مع ما يبحث عنه",
    background: "اهتمامات وخبرات مهنية متقاربة",
    featured: "عارض مميّز من طرف المنظّم",
  },
};

@Controller("api/networking/:slug")
export class NetworkingRecommendationsController {
  private readonly candidates = new NetworkingRecommendationCache();
  constructor(private readonly networking: NetworkingService) {}

  @Get("recommendations")
  async recommendations(
    @Param("slug") slug: string,
    @Ip() ip: string,
    @Headers("authorization") authorization?: string,
  ) {
    const ctx = await this.networking.participant(slug, authorization, { ip });
    if (!ctx.config.swipeEnabled && !ctx.config.searchEnabled)
      throw new ForbiddenException({ code: "NETWORKING_FEATURE_DISABLED", message: "Participant discovery is disabled" });
    const model =
      process.env.NETWORKING_EMBEDDING_MODEL || "text-embedding-3-small";
    const cacheKey = JSON.stringify([
      ctx.event.id,
      ctx.profile.id,
      model,
      profileEmbeddingInput(ctx.profile).hash,
      [...ctx.config.eligiblePaymentStatuses].sort(),
    ]);
    const loadCandidates = () =>
      findNetworkingVectorCandidates(
        ctx.event.id,
        ctx.profile.id,
        model,
        ctx.config.eligiblePaymentStatuses,
        60,
      );
    let candidates = await this.candidates.get(cacheKey, loadCandidates);
    if (candidates === null || !candidates.length) {
      const result = await this.networking.discover(ctx, {
        sort: "recent",
        limit: 100,
        excludeInteracted: true,
      });
      const ownTags = new Set(
        ctx.profile.interests.map((value) => value.toLocaleLowerCase()),
      );
      const items = result.items
        .map((profile) => {
          const shared = (profile.interests as string[]).filter((value) =>
            ownTags.has(value.toLocaleLowerCase()),
          );
          return {
            ...profile,
            score:
              shared.length + (profile.sector === ctx.profile.sector ? 1 : 0),
            reasons: shared,
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 30);
      return { items, total: items.length, strategy: "PROFILE_RULES" };
    }
    let profiles = await getNetworkingRecommendationProfiles(
      ctx.event.id,
      candidates.map((candidate) => candidate.profileId),
      ctx.profile.id,
      ctx.config.eligiblePaymentStatuses,
    );
    // Swiping/blocking can exhaust a cached page. Refill once using current filters.
    if (profiles.length < Math.min(30, candidates.length)) {
      this.candidates.invalidate(cacheKey, candidates);
      candidates = (await this.candidates.get(cacheKey, loadCandidates)) ?? [];
      profiles = await getNetworkingRecommendationProfiles(
        ctx.event.id,
        candidates.map((candidate) => candidate.profileId),
        ctx.profile.id,
        ctx.config.eligiblePaymentStatuses,
      );
    }
    const profilesById = new Map(
      profiles.map((profile) => [profile.id, profile]),
    );
    const copy = reasons[ctx.profile.language];
    const items = candidates
      .flatMap((candidate) => {
        const profile = profilesById.get(candidate.profileId);
        if (!profile) return [];
        const explanation: string[] = [];
        if (candidate.needsScore >= 0.45) explanation.push(copy.needs);
        if (candidate.offersScore >= 0.45) explanation.push(copy.offers);
        if (candidate.profileScore >= 0.45) explanation.push(copy.background);
        if (profile.featured) explanation.push(copy.featured);
        // Activity is a small tie-breaker; never substitutes for semantic compatibility.
        const activity = profile.lastActiveAt
          ? Math.max(
              0,
              1 -
                (Date.now() - profile.lastActiveAt.getTime()) /
                  (7 * 86_400_000),
            )
          : 0;
        return [
          {
            ...networkingPublicProfile(profile),
            score:
              candidate.score * 0.95 +
              activity * 0.03 +
              (profile.featured ? 0.02 : 0),
            reasons: explanation,
          },
        ];
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);
    return { items, total: items.length, strategy: "VECTOR", model };
  }
}

@Auth()
@Controller("api/events/:eventId/networking/recommendations")
export class NetworkingRecommendationAdminController {
  private async access(user: AuthUser, eventId: string, write = false) {
    const event = await assertEventAccess(user, eventId);
    await assertClientModuleEnabled(event.clientId, "networking");
    if (write) assertEventWritable(event);
  }
  @Get("status")
  async status(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
  ) {
    await this.access(user, eventId);
    return {
      configured: Boolean(
        process.env.NETWORKING_EMBEDDING_API_KEY || process.env.OPENAI_API_KEY,
      ),
      model: process.env.NETWORKING_EMBEDDING_MODEL || "text-embedding-3-small",
      dimensions: 1536,
      jobs: await getNetworkingEmbeddingHealth(eventId),
    };
  }
  @Post("reindex")
  async reindex(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
  ) {
    await this.access(user, eventId, true);
    return { queued: await reindexNetworkingEvent(eventId) };
  }
}
