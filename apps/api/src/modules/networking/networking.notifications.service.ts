import { Injectable } from "@nestjs/common";
import { networkingStore, listNetworkingNotifications } from "@app/db";
import { networkingValidation } from "./networking.errors";
import type { NetworkingContext } from "./networking.service";
import type * as dto from "./networking.dto";

@Injectable()
export class NetworkingNotificationsService {
  async list(ctx: NetworkingContext, query: dto.NetworkingListDto) {
    return listNetworkingNotifications(
      ctx.event.id,
      ctx.profile.id,
      query.page,
      query.limit,
    );
  }
  async markRead(ctx: NetworkingContext, body: dto.NetworkingNotificationReadDto) {
    if (body.ids) {
      for (const id of body.ids)
        await networkingStore().update(
          "notifications",
          { eventId: ctx.event.id, profileId: ctx.profile.id, id },
          { readAt: new Date() },
        );
    } else
      await networkingStore().update(
        "notifications",
        { eventId: ctx.event.id, profileId: ctx.profile.id, readAt: null },
        { readAt: new Date() },
      );
    return { read: true };
  }
  async subscribePush(ctx: NetworkingContext, body: dto.NetworkingPushDto) {
    assertSupportedPushEndpoint(body.endpoint);
    // One upsert on the unique endpoint: a browser re-subscribing moves its endpoint to this participant.
    return networkingStore().upsertPushSubscription({
      eventId: ctx.event.id,
      profileId: ctx.profile.id,
      endpoint: body.endpoint,
      keys: body.keys,
      expirationTime: body.expirationTime ? new Date(body.expirationTime) : null,
    });
  }
  async unsubscribePush(ctx: NetworkingContext, body: { endpoint?: string }) {
    await networkingStore().remove("pushSubscriptions", {
      eventId: ctx.event.id,
      profileId: ctx.profile.id,
      ...(body?.endpoint ? { endpoint: body.endpoint } : {}),
    });
    return { unsubscribed: true };
  }
}

export function assertSupportedPushEndpoint(endpoint: string): void {
  const unsupported = () => networkingValidation("Unsupported push service endpoint");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw unsupported();
  }
  const host = url.hostname;
  const allowed = [
    "fcm.googleapis.com",
    "push.services.mozilla.com",
    "push.apple.com",
    "notify.windows.com",
  ].some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (!allowed || url.username || url.password || url.port)
    throw unsupported();
}
