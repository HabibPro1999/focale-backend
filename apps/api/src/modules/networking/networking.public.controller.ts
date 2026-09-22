import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import {
  NetworkingUploadsService,
  type NetworkingMultipartRequest,
} from "./networking.uploads.service";
import { Throttle } from "@nestjs/throttler";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  networkingDirectoryFacets,
  listNetworkingNotifications,
  recordNetworkingProfileView,
  networkingNotificationsSince,
  networkingStore,
  networkingTransaction,
  revokeNetworkingSessions,
} from "@app/db";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { NetworkingService } from "./networking.service";
import { NetworkingSocialService } from "./networking.social.service";
import { NetworkingMeetingsService } from "./networking.meetings.service";
import { NetworkingExportsService } from "./networking.exports.service";
import { issueNetworkingBadge } from "./networking.security";
import { networkingPublicProfile, networkingSlots } from "./networking.policy";
import * as dto from "./networking.dto";
@Controller("api/networking/:slug")
export class NetworkingPublicController {
  constructor(
    private readonly uploads: NetworkingUploadsService,
    private readonly service: NetworkingService,
    private readonly social: NetworkingSocialService,
    private readonly meetings: NetworkingMeetingsService,
    private readonly exports: NetworkingExportsService,
  ) {}
  private context(slug: string, request: FastifyRequest) {
    return this.service.participant(slug, request.headers.authorization);
  }
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @Get("config") config(@Param("slug") slug: string) {
    return this.service.publicConfig(slug);
  }
  @Post("auth/request")
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  requestCode(
    @Param("slug") slug: string,
    @Body() body: dto.NetworkingOtpRequestDto,
  ) {
    return this.service.requestCode(slug, body.email);
  }
  @Post("auth/verify")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  verifyCode(
    @Param("slug") slug: string,
    @Body() body: dto.NetworkingOtpVerifyDto,
  ) {
    return this.service.verifyCode(slug, body.challengeId, body.code);
  }
  @Post("auth/logout") async logout(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
  ) {
    const ctx = await this.service.participant(
      slug,
      req.headers.authorization,
      { allowPendingSecondFactor: true },
    );
    await networkingStore().update(
      "sessions",
      { id: ctx.session.id, eventId: ctx.event.id },
      { revokedAt: new Date() },
    );
    return { loggedOut: true };
  }
  @Get("me") async me(@Param("slug") slug: string, @Req() req: FastifyRequest) {
    return (await this.context(slug, req)).profile;
  }
  @Get("me/analytics") async personalAnalytics(@Param("slug") slug: string, @Req() req: FastifyRequest) {
    return this.service.personalAnalytics(await this.context(slug, req));
  }
  @Patch("me") async updateMe(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Body() body: dto.NetworkingProfileDto,
  ) {
    return this.service.updateMe(await this.context(slug, req), { ...body });
  }
  @Post("me/photo")
  async uploadPhoto(
    @Param("slug") slug: string,
    @Req() request: NetworkingMultipartRequest,
  ) {
    const ctx = await this.context(slug, request);
    return this.uploads.image(
      request,
      `networking/${ctx.event.id}/profiles/${ctx.profile.id}`,
      (url) => this.service.updateMe(ctx, { photoUrl: url }),
      ctx.profile.photoUrl,
    );
  }
  @Get("interests/incoming")
  async incomingInterests(
    @Param("slug") slug: string,
    @Req() request: FastifyRequest,
  ) {
    return this.social.incoming(await this.context(slug, request));
  }
  @Get("facets")
  async facets(@Param("slug") slug: string, @Req() request: FastifyRequest) {
    const ctx = await this.context(slug, request);
    if (!ctx.config.searchEnabled)
      throw new BadRequestException("Search is disabled");
    return networkingDirectoryFacets(
      ctx.event.id,
      ctx.profile.id,
      ctx.config.eligiblePaymentStatuses,
    );
  }
  @Get("profiles") async profiles(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Query() query: dto.NetworkingListDto,
  ) {
    return this.service.discover(await this.context(slug, req), query);
  }
  @Get("profiles/:id/representatives") async representatives(
    @Param("slug") slug: string, @Param("id") id: string, @Req() req: FastifyRequest, @Query() query: dto.NetworkingListDto,
  ) {
    return this.service.representatives(await this.context(slug, req), id, query.page);
  }
  @Get("profiles/:id") async profile(
    @Param("slug") slug: string,
    @Param("id") id: string,
    @Req() req: FastifyRequest,
    @Query() query: dto.NetworkingListDto,
  ) {
    const ctx = await this.context(slug, req);
    const profile = await this.service.target(ctx, id);
    await recordNetworkingProfileView(ctx.event.id, ctx.profile.id, id, query.viewId);
    return networkingPublicProfile(profile);
  }
  @Post("interests") async interest(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Body() body: dto.NetworkingInterestDto,
  ) {
    return this.social.interest(
      await this.context(slug, req),
      body.profileId,
      body.action,
    );
  }
  @Delete("interests") async resetInterests(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
  ) {
    const ctx = await this.context(slug, req);
    await networkingStore().remove("interests", {
      eventId: ctx.event.id,
      profileId: ctx.profile.id,
      action: "PASS",
    });
    return { reset: true };
  }
  @Get("connections") async connections(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Query() query: dto.NetworkingParticipantListDto,
  ) {
    return this.social.connections(await this.context(slug, req), query);
  }
  @Get("connections/:id/messages") async messages(
    @Param("slug") slug: string,
    @Param("id") id: string,
    @Req() req: FastifyRequest,
    @Query() query: dto.NetworkingListDto,
  ) {
    return this.social.messages(await this.context(slug, req), id, query);
  }
  @Post("connections/:id/messages")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async message(
    @Param("slug") slug: string,
    @Param("id") id: string,
    @Req() req: FastifyRequest,
    @Body() body: dto.NetworkingMessageDto,
  ) {
    return this.social.sendMessage(
      await this.context(slug, req),
      id,
      body.body,
      body.clientMessageId,
    );
  }
  @Post("connections/:id/read") async read(
    @Param("slug") slug: string,
    @Param("id") id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.social.markRead(await this.context(slug, req), id);
  }
  @Get("blocks") async blocks(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
  ) {
    const ctx = await this.context(slug, req);
    const rows = await networkingStore().all("blocks", {
      eventId: ctx.event.id,
      profileId: ctx.profile.id,
    });
    const items = await Promise.all(
      rows.map(async (row) => {
        const profile = await networkingStore().one("profiles", {
          id: row.targetId,
          eventId: ctx.event.id,
        });
        return {
          ...row,
          profile: profile ? networkingPublicProfile(profile) : null,
        };
      }),
    );
    return { items, total: items.length };
  }
  @Post("blocks") async block(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Body() body: dto.NetworkingBlockDto,
  ) {
    return this.social.block(await this.context(slug, req), body.profileId);
  }
  @Delete("blocks/:id") async unblock(
    @Param("slug") slug: string,
    @Param("id") id: string,
    @Req() req: FastifyRequest,
  ) {
    const ctx = await this.context(slug, req);
    await networkingStore().remove("blocks", {
      eventId: ctx.event.id,
      profileId: ctx.profile.id,
      targetId: id,
    });
    return { unblocked: true };
  }
  @Post("reports")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async report(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Body() body: dto.NetworkingReportDto,
  ) {
    return this.social.report(await this.context(slug, req), body);
  }
  @Get("availability") async availability(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
  ) {
    return this.meetings.availability(await this.context(slug, req));
  }
  @Put("availability") async updateAvailability(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Body() body: dto.NetworkingAvailabilityDto,
  ) {
    return this.meetings.saveAvailability(
      await this.context(slug, req),
      body.slots,
    );
  }
  @Get("profiles/:id/availability") async profileAvailability(
    @Param("slug") slug: string,
    @Param("id") id: string,
    @Req() req: FastifyRequest,
  ) {
    const ctx = await this.context(slug, req);
    this.meetings.requireEnabled(ctx);
    return {
      slots: await this.meetings.participantSlots(ctx, id),
      availableSlots: networkingSlots(ctx.config, ctx.event).filter(slot => Date.parse(slot) > Date.now()),
    };
  }
  @Get("meetings") async listMeetings(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Query() query: dto.NetworkingParticipantListDto,
  ) {
    return this.meetings.list(await this.context(slug, req), query);
  }
  @Post("meetings") async createMeeting(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Body() body: dto.NetworkingMeetingCreateDto,
  ) {
    return this.meetings.create(await this.context(slug, req), body);
  }
  @Post("meetings/:id/respond") async respond(
    @Param("slug") slug: string,
    @Param("id") id: string,
    @Req() req: FastifyRequest,
    @Body() body: dto.NetworkingMeetingRespondDto,
  ) {
    return this.meetings.respond(await this.context(slug, req), id, body);
  }
  @Post("meetings/:id/checkin") async checkin(
    @Param("slug") slug: string,
    @Param("id") id: string,
    @Req() req: FastifyRequest,
    @Body() body: dto.NetworkingCheckinDto,
  ) {
    return this.meetings.checkin(await this.context(slug, req), id, body.token);
  }
  @Get("badge") async badge(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
  ) {
    const ctx = await this.context(slug, req);
    return {
      ...issueNetworkingBadge(ctx.profile.id, ctx.event.id),
      accessAllowed: await this.service.areaAccess(ctx),
    };
  }
  @Get("notifications") async notifications(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Query() query: dto.NetworkingListDto,
  ) {
    const ctx = await this.context(slug, req);
    return listNetworkingNotifications(
      ctx.event.id,
      ctx.profile.id,
      query.page,
      query.limit,
    );
  }

  @Post("notifications/read") async readNotifications(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Body() body: dto.NetworkingNotificationReadDto,
  ) {
    const ctx = await this.context(slug, req);
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
  @Post("push-subscriptions") async subscribe(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Body() body: dto.NetworkingPushDto,
  ) {
    const ctx = await this.context(slug, req);
    const url = new URL(body.endpoint);
    const host = url.hostname;
    const allowed = [
      "fcm.googleapis.com",
      "push.services.mozilla.com",
      "push.apple.com",
      "notify.windows.com",
    ].some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
    if (!allowed || url.username || url.password || url.port)
      throw new BadRequestException("Unsupported push service endpoint");
    return networkingTransaction(ctx.event.id, async (store) => {
      const existing = await store.one("pushSubscriptions", {
        endpoint: body.endpoint,
      });
      if (existing && existing.profileId !== ctx.profile.id)
        await store.remove("pushSubscriptions", { id: existing.id });
      if (existing && existing.profileId === ctx.profile.id) {
        const [row] = await store.update(
          "pushSubscriptions",
          { id: existing.id, profileId: ctx.profile.id },
          {
            keys: body.keys,
            expirationTime: body.expirationTime
              ? new Date(body.expirationTime)
              : null,
          },
        );
        return row;
      }
      return store.insert("pushSubscriptions", {
        eventId: ctx.event.id,
        profileId: ctx.profile.id,
        endpoint: body.endpoint,
        keys: body.keys,
        expirationTime: body.expirationTime
          ? new Date(body.expirationTime)
          : null,
      });
    });
  }
  @Delete("push-subscriptions") async unsubscribe(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Body() body: { endpoint?: string },
  ) {
    const ctx = await this.context(slug, req);
    await networkingStore().remove("pushSubscriptions", {
      eventId: ctx.event.id,
      profileId: ctx.profile.id,
      ...(body?.endpoint ? { endpoint: body.endpoint } : {}),
    });
    return { unsubscribed: true };
  }
  @Get("calendar.ics") @SkipEnvelope() async calendar(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const ctx = await this.context(slug, req);
    return reply
      .type("text/calendar; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="networking.ics"')
      .send(await this.exports.calendar(ctx));
  }
  @Get("connections/export") @SkipEnvelope() async exportConnections(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const ctx = await this.context(slug, req);
    return reply
      .type("text/csv; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="connections.csv"')
      .send(await this.exports.connections(ctx));
  }
  @Get("me/export") @SkipEnvelope() async exportMe(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const ctx = await this.context(slug, req);
    return reply
      .type("application/json")
      .header(
        "Content-Disposition",
        'attachment; filename="networking-data.json"',
      )
      .send(await this.exports.personal(ctx));
  }
  @Delete("me") async withdraw(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
  ) {
    const ctx = await this.context(slug, req);
    const photoUrl = await networkingTransaction(ctx.event.id, async (store, db) => {
      const current = await store.one("profiles", { eventId: ctx.event.id, id: ctx.profile.id });
      await store.update(
        "profiles",
        { eventId: ctx.event.id, id: ctx.profile.id },
        {
          photoUrl: null,
          consent: false,
          visible: false,
          withdrawnAt: new Date(),
          overrides: { ...ctx.profile.overrides, consent: false },
        },
      );
      await revokeNetworkingSessions(ctx.profile.id, db);
      await store.remove("pushSubscriptions", {
        eventId: ctx.event.id,
        profileId: ctx.profile.id,
      });
      const meetings = (
        await store.all("meetings", { eventId: ctx.event.id })
      ).filter(
        (m) =>
          [m.requesterId, m.recipientId].includes(ctx.profile.id) &&
          ["PENDING", "PENDING_ALLOCATION", "CONFIRMED"].includes(m.status) &&
          m.endsAt > new Date(),
      );
      for (const row of meetings) {
        const [saved] = await store.update(
          "meetings",
          { eventId: ctx.event.id, id: row.id },
          { status: "CANCELLED", revision: row.revision + 1 },
        );
        await store.remove("reservations", {
          eventId: ctx.event.id,
          meetingId: row.id,
        });
        await this.meetings.notify(
          ctx,
          saved,
          "MEETING_CANCELLED",
          [row.requesterId, row.recipientId],
          db,
        );
      }
      return current?.photoUrl;
    });
    await this.uploads.deletePhoto(photoUrl, ctx.profile.id);
    return { withdrawn: true };
  }
  @Get("stream") @SkipEnvelope() async stream(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    await this.context(slug, req);
    reply.hijack();
    for (const [key, value] of Object.entries(reply.getHeaders()))
      if (value !== undefined) reply.raw.setHeader(key, value);
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    reply.raw.write(`event: ready\ndata: {}\n\n`);
    let last = Date.now();
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const ctx = await this.context(slug, req);
        const checkedAt = Date.now();
        const rows = await networkingNotificationsSince(ctx.event.id, ctx.profile.id, new Date(last));
        last = checkedAt;
        if (rows.length)
          reply.raw.write(
            `event: notifications\ndata: ${JSON.stringify(rows)}\n\n`,
          );
        else reply.raw.write(": heartbeat\n\n");
      } catch {
        reply.raw.end();
      } finally {
        busy = false;
      }
    }, 3000);
    const timeout = setTimeout(() => reply.raw.end(), 60_000);
    reply.raw.on("close", () => {
      clearInterval(timer);
      clearTimeout(timeout);
    });
  }
}
