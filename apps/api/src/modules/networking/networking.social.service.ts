import { ErrorCodes, type NetworkingParticipantListQuery } from "@app/contracts";
import { participantPagination } from "./networking.pagination";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  listNetworkingMessages,
  listNetworkingConnectionSummaries,
  countNetworkingConnectionSummaries,
  markNetworkingMessageNotificationsRead,
  createNetworkingNotification,
  networkingStore,
  networkingTransaction,
  type NetworkingStore,
} from "@app/db";
import {
  NetworkingService,
  type NetworkingContext,
} from "./networking.service";
import { networkingPair, networkingPublicProfile } from "./networking.policy";
const notFound = (message: string) => new NotFoundException({ code: ErrorCodes.NETWORKING_NOT_FOUND, message });
type ConnectionSummaryRow = Awaited<ReturnType<typeof listNetworkingConnectionSummaries>>[number];
const summary = (row: ConnectionSummaryRow) => ({ ...row, profile: networkingPublicProfile(row.profile) });
@Injectable()
export class NetworkingSocialService {
  constructor(private readonly networking: NetworkingService) {}
  async incoming(ctx: NetworkingContext) {
    if (!ctx.profile.featured && !ctx.profile.standTableId)
      throw new ForbiddenException({ code: "NETWORKING_FEATURE_DISABLED", message: "Incoming interests are available to exhibitors" });
    const interests = await networkingStore().all("interests", {
      eventId: ctx.event.id,
      targetId: ctx.profile.id,
      action: "LIKE",
    });
    const items = [];
    for (const interest of interests) {
      try {
        const profile = await this.networking.target(ctx, interest.profileId);
        items.push({
          id: interest.id,
          profile: networkingPublicProfile(profile),
          createdAt: interest.createdAt,
        });
      } catch (error) {
        if (!(error instanceof NotFoundException)) throw error;
      }
    }
    return { items, total: items.length };
  }
  async connection(
    ctx: NetworkingContext,
    id: string,
    store = networkingStore(),
  ) {
    const row = await store.one("connections", { id, eventId: ctx.event.id });
    if (
      !row ||
      (row.profileAId !== ctx.profile.id && row.profileBId !== ctx.profile.id)
    )
      throw notFound("Connection not found");
    const profile = await this.networking.target(
      ctx,
      row.profileAId === ctx.profile.id ? row.profileBId : row.profileAId,
      store,
    );
    return { ...row, profile };
  }
  async interest(
    ctx: NetworkingContext,
    targetId: string,
    action: "LIKE" | "PASS",
  ) {
    if (!ctx.config.swipeEnabled && !ctx.config.searchEnabled)
      throw new ForbiddenException({ code: "NETWORKING_FEATURE_DISABLED", message: "Discovery is disabled" });
    return networkingTransaction(ctx.event.id, async (store, db) => {
      ctx = await this.networking.currentParticipant(ctx, store);
      if (!ctx.config.swipeEnabled && !ctx.config.searchEnabled)
        throw new ForbiddenException({ code: "NETWORKING_FEATURE_DISABLED", message: "Discovery is disabled" });
      const target = await this.networking.target(ctx, targetId, store, true);
      const existing = await store.one("interests", {
        eventId: ctx.event.id,
        profileId: ctx.profile.id,
        targetId,
      });
      if (existing)
        await store.update(
          "interests",
          { id: existing.id, eventId: ctx.event.id },
          { action },
        );
      else
        await store.insert("interests", {
          eventId: ctx.event.id,
          profileId: ctx.profile.id,
          targetId,
          action,
        });
      if (!existing || existing.action !== action)
        await store.insert("audit", {
          eventId: ctx.event.id,
          actorId: ctx.profile.id,
          action: `SWIPE_${action}`,
          targetId,
          data: { previousAction: existing?.action ?? null },
        });
      if (action !== "LIKE") return { matched: false };
      const reciprocal = await store.one("interests", {
        eventId: ctx.event.id,
        profileId: targetId,
        targetId: ctx.profile.id,
        action: "LIKE",
      });
      if (!reciprocal) return { matched: false };
      const [profileAId, profileBId] = networkingPair(ctx.profile.id, targetId);
      let connection = await store.one("connections", {
        eventId: ctx.event.id,
        profileAId,
        profileBId,
      });
      if (!connection) {
        connection = await store.insert("connections", {
          eventId: ctx.event.id,
          profileAId,
          profileBId,
        });
        for (const profileId of [profileAId, profileBId])
          await createNetworkingNotification(
            {
              eventId: ctx.event.id,
              profileId,
              type: "MATCH",
              title: "New connection",
              body: "You have a new mutual connection.",
              href: `/e/${ctx.event.slug}/connections/${connection.id}`,
              data: { connectionId: connection.id, counterpartName: profileId === ctx.profile.id ? `${target.firstName} ${target.lastName}`.trim() : `${ctx.profile.firstName} ${ctx.profile.lastName}`.trim() },
            },
            db,
          );
      }
      return { matched: true, connectionId: connection.id };
    });
  }
  async connections(ctx: NetworkingContext, query: NetworkingParticipantListQuery = {}) {
    const page = participantPagination("connections", ctx, query);
    const rows = await listNetworkingConnectionSummaries(ctx.event.id, ctx.profile.id, ctx.config.eligiblePaymentStatuses, page);
    const visibleRows = rows.slice(0, page.limit);
    const last = visibleRows.at(-1);
    return {
      items: visibleRows.map(summary),
      nextCursor: rows.length > page.limit && last ? page.cursor(last.createdAt, last.id) : null,
      // Counted once per listing: later pages never repeat the aggregate.
      ...(page.after ? {} : { total: await countNetworkingConnectionSummaries(ctx.event.id, ctx.profile.id, ctx.config.eligiblePaymentStatuses) }),
    };
  }
  /** Internal, unpaginated: exports must never be truncated. Not exposed over HTTP. */
  async allConnections(ctx: NetworkingContext) {
    return (await listNetworkingConnectionSummaries(ctx.event.id, ctx.profile.id, ctx.config.eligiblePaymentStatuses)).map(summary);
  }
  /** One visible connection summary, same shape as a GET connections item (K2). */
  async connectionSummary(ctx: NetworkingContext, id: string) {
    await this.connection(ctx, id);
    const [row] = await listNetworkingConnectionSummaries(ctx.event.id, ctx.profile.id, ctx.config.eligiblePaymentStatuses, undefined, { connectionId: id });
    if (!row) throw notFound("Connection not found");
    return summary(row);
  }
  async connectionWith(ctx: NetworkingContext, profileId: string) {
    if (profileId === ctx.profile.id) return null;
    const [profileAId, profileBId] = networkingPair(ctx.profile.id, profileId);
    const row = await networkingStore().one("connections", { eventId: ctx.event.id, profileAId, profileBId });
    if (!row) return null;
    try {
      return await this.connectionSummary(ctx, row.id);
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
  }
  async messages(
    ctx: NetworkingContext,
    id: string,
    query: { before?: string; beforeId?: string; limit?: number } = {},
  ) {
    if (!ctx.config.chatEnabled)
      throw new ForbiddenException({ code: "NETWORKING_FEATURE_DISABLED", message: "Chat is disabled" });
    if (query.beforeId && !query.before)
      throw new BadRequestException({ code: "NETWORKING_VALIDATION", message: "A message timestamp is required with beforeId" });
    await this.connection(ctx, id);
    return listNetworkingMessages(ctx.event.id, id, query);
  }

  async sendMessage(
    ctx: NetworkingContext,
    id: string,
    body: string,
    clientMessageId: string,
  ) {
    if (!ctx.config.chatEnabled)
      throw new ForbiddenException({ code: "NETWORKING_FEATURE_DISABLED", message: "Chat is disabled" });
    return networkingTransaction(ctx.event.id, async (store, db) => {
      ctx = await this.networking.currentParticipant(ctx, store);
      if (!ctx.config.chatEnabled)
        throw new ForbiddenException({ code: "NETWORKING_FEATURE_DISABLED", message: "Chat is disabled" });
      const connection = await this.connection(ctx, id, store);
      const previous = await store.one("messages", {
        senderId: ctx.profile.id,
        clientMessageId,
      });
      if (previous) {
        if (previous.connectionId !== id || previous.body !== body)
          throw new BadRequestException({ code: "NETWORKING_VALIDATION", message: "Message key was already used for another message" });
        return previous;
      }
      const message = await store.insert("messages", {
        eventId: ctx.event.id,
        connectionId: id,
        senderId: ctx.profile.id,
        body,
        clientMessageId,
      });
      await store.update(
        "connections",
        { id, eventId: ctx.event.id },
        connection.profileAId === ctx.profile.id
          ? { readAAt: message.createdAt }
          : { readBAt: message.createdAt },
      );
      await createNetworkingNotification(
        {
          eventId: ctx.event.id,
          profileId: connection.profile.id,
          type: "MESSAGE",
          title: "New message",
          body: `${ctx.profile.firstName} sent you a message.`,
          href: `/e/${ctx.event.slug}/connections/${id}`,
          data: { connectionId: id, messageId: message.id, counterpartName: `${ctx.profile.firstName} ${ctx.profile.lastName}`.trim() },
        },
        db,
      );
      return message;
    });
  }
  async markRead(ctx: NetworkingContext, id: string) {
    const row = await this.connection(ctx, id);
    const readAt = new Date();
    await networkingStore().update(
      "connections",
      { id, eventId: ctx.event.id },
      row.profileAId === ctx.profile.id
        ? { readAAt: readAt }
        : { readBAt: readAt },
    );
    await markNetworkingMessageNotificationsRead(ctx.event.id, ctx.profile.id, id, readAt);
    return { read: true };
  }
  async block(ctx: NetworkingContext, targetId: string) {
    return networkingTransaction(ctx.event.id, async (store, db) => {
      ctx = await this.networking.currentParticipant(ctx, store);
      if (targetId === ctx.profile.id)
        throw new BadRequestException({ code: "NETWORKING_VALIDATION", message: "Cannot block yourself" });
      const target = await store.one("profiles", {
        id: targetId,
        eventId: ctx.event.id,
      });
      if (!target) throw notFound("Participant not found");
      if (
        !(await store.one("blocks", {
          eventId: ctx.event.id,
          profileId: ctx.profile.id,
          targetId,
        }))
      )
        await store.insert("blocks", {
          eventId: ctx.event.id,
          profileId: ctx.profile.id,
          targetId,
        });
      const meetings = (
        await store.all("meetings", { eventId: ctx.event.id })
      ).filter(
        (m) =>
          ((m.requesterId === ctx.profile.id && m.recipientId === targetId) ||
            (m.recipientId === ctx.profile.id && m.requesterId === targetId)) &&
          ["PENDING", "PENDING_ALLOCATION", "CONFIRMED"].includes(m.status) &&
          m.endsAt > new Date(),
      );
      for (const meeting of meetings) {
        await store.update(
          "meetings",
          { id: meeting.id, eventId: ctx.event.id },
          {
            status: "CANCELLED",
            revision: meeting.revision + 1,
            proposedStartsAt: null,
            proposalBy: null,
          },
        );
        await store.remove("reservations", {
          eventId: ctx.event.id,
          meetingId: meeting.id,
        });
        for (const profileId of [meeting.requesterId, meeting.recipientId])
          await createNetworkingNotification(
            {
              eventId: ctx.event.id,
              profileId,
              type: "MEETING_CANCELLED",
              title: "Meeting cancelled",
              body: "This meeting is no longer available.",
              href: `/e/${ctx.event.slug}/agenda`,
              // A block never names the other participant (K5).
              data: {
                meetingId: meeting.id, revision: meeting.revision + 1, action: "CANCEL",
                startsAt: meeting.startsAt.toISOString(), endsAt: meeting.endsAt.toISOString(),
                status: "CANCELLED",
              },
            },
            db,
          );
      }
      return { blocked: true };
    });
  }
  async report(
    ctx: NetworkingContext,
    input: { profileId: string; messageId?: string; reason: string },
  ) {
    const store = networkingStore();
    if (
      input.profileId === ctx.profile.id ||
      !(await store.one("profiles", {
        id: input.profileId,
        eventId: ctx.event.id,
      }))
    )
      throw notFound("Participant not found");
    if (input.messageId) {
      const message = await store.one("messages", {
        id: input.messageId,
        eventId: ctx.event.id,
        senderId: input.profileId,
      });
      const connection = message
        ? await store.one("connections", {
            id: message.connectionId,
            eventId: ctx.event.id,
          })
        : null;
      if (
        !connection ||
        (connection.profileAId !== ctx.profile.id &&
          connection.profileBId !== ctx.profile.id)
      )
        throw notFound("Message not found");
    }
    return store.insert("reports", {
      eventId: ctx.event.id,
      reporterId: ctx.profile.id,
      ...input,
    });
  }
}
