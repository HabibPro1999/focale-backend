import { ForbiddenException } from "@nestjs/common";
import { ErrorCodes } from "@app/contracts";
import { getDb, networkingStore, listNetworkingDiscovery, networkingDirectoryFacets, recordNetworkingProfileView } from "@app/db";
import { networkingPublicProfile } from "./networking.policy";
import { requireNetworkingDiscovery } from "./networking.errors";
import { activeNetworkingStand } from "./networking.stand";
import type { NetworkingContext, NetworkingDiscoveryQuery, NetworkingService } from "./networking.service";

export async function discoverNetworkingProfiles(ctx: NetworkingContext, query: NetworkingDiscoveryQuery = {}) {
  requireNetworkingDiscovery(ctx.config);
  if (
    (query.q ||
      query.sector ||
      query.sectors?.length ||
      query.company ||
      query.city ||
      query.country) &&
    !ctx.config.searchEnabled
  )
    throw new ForbiddenException({ code: ErrorCodes.NETWORKING_FEATURE_DISABLED, message: "Search is disabled" });
  const result = await listNetworkingDiscovery(
    ctx.event.id,
    ctx.profile.id,
    ctx.config.eligiblePaymentStatuses,
    query,
  );
  return {
    items: result.items.map(networkingPublicProfile),
    total: result.total,
  };
}

export async function networkingRepresentatives(networking: Pick<NetworkingService, "target">, ctx: NetworkingContext, profileId: string, page = 1) {
  requireNetworkingDiscovery(ctx.config);
  const profile = await networking.target(ctx, profileId);
  const active = profile.standTableId ? await activeNetworkingStand(networkingStore(getDb()), ctx.event.id, profile.standTableId) : null;
  if (!active) return { items: [], total: 0, exhibitor: null };
  const { stand, space } = active;
  const result = await listNetworkingDiscovery(ctx.event.id, ctx.profile.id, ctx.config.eligiblePaymentStatuses,
    { standTableId: stand.id, page, limit: 30 });
  return { items: result.items.map(networkingPublicProfile), total: result.total,
    exhibitor: { id: stand.id, name: stand.name, spaceName: space?.name ?? null } };
}

export async function networkingFacets(ctx: NetworkingContext) {
  if (!ctx.config.searchEnabled)
    throw new ForbiddenException({ code: ErrorCodes.NETWORKING_FEATURE_DISABLED, message: "Search is disabled" });
  return networkingDirectoryFacets(ctx.event.id, ctx.profile.id, ctx.config.eligiblePaymentStatuses);
}

export async function viewNetworkingProfile(networking: Pick<NetworkingService, "target">, ctx: NetworkingContext, id: string, viewId?: string) {
  const profile = await networking.target(ctx, id);
  await recordNetworkingProfileView(ctx.event.id, ctx.profile.id, id, viewId);
  return networkingPublicProfile(profile);
}
