import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  createNetworkingNotification,
  expireNetworkingProposals,
  listNetworkingParticipantMeetings,
  networkingStore,
  networkingTransaction,
  type NetworkingRow,
  type NetworkingStore,
  type DbExecutor,
} from "@app/db";
import {
  NetworkingService,
  type NetworkingContext,
} from "./networking.service";
import {
  networkingPair,
  networkingPublicProfile,
  networkingSlots,
  resourceQuanta,
} from "./networking.policy";
import { networkingInventoryResource } from "./networking.inventory-policy";
@Injectable()
export class NetworkingMeetingsService {
  constructor(private readonly networking: NetworkingService) {}
  requireEnabled(ctx: NetworkingContext) {
    if (!ctx.config.meetingsEnabled || !ctx.profile.meetingsEnabled)
      throw new ForbiddenException("Meetings are disabled");
  }
  async participantSlots(
    ctx: NetworkingContext,
    profileId: string,
    store = networkingStore(),
  ) {
    const profile =
      profileId === ctx.profile.id
        ? ctx.profile
        : await this.networking.target(ctx, profileId, store);
    if (!profile.meetingsEnabled) return [];
    if (profile.standTableId) {
      const stand = await store.one("tables", { eventId: ctx.event.id, id: profile.standTableId, kind: "STAND" });
      const space = stand?.spaceId ? await store.one("spaces", { eventId: ctx.event.id, id: stand.spaceId }) : null;
      if (!stand?.active || space?.active === false) return [];
    }
    const availableSlots = networkingSlots(ctx.config, ctx.event).filter(
      (v) => Date.parse(v) > Date.now(),
    );
    const own = profile.availabilitySet
      ? new Set(
          (
            await store.all("availability", {
              eventId: ctx.event.id,
              profileId,
            })
          ).map((v) => v.startsAt.toISOString()),
        )
      : new Set<string>();
    const booked = await store.all("reservations", {
      eventId: ctx.event.id,
      resourceKey: `profile:${profileId}`,
    });
    return availableSlots.filter(
      (v) =>
        own.has(v) &&
        !resourceQuanta(
          new Date(v),
          new Date(Date.parse(v) + ctx.config.slotDurationMinutes * 60_000),
        ).some((q) => booked.some((b) => b.startsAt.getTime() === q.getTime())),
    );
  }
  async availability(ctx: NetworkingContext) {
    this.requireEnabled(ctx);
    const availableSlots = networkingSlots(ctx.config, ctx.event).filter(
      (v) => Date.parse(v) > Date.now(),
    );
    const selected = ctx.profile.availabilitySet
      ? (
          await networkingStore().all("availability", {
            eventId: ctx.event.id,
            profileId: ctx.profile.id,
          })
        )
          .map((row) => row.startsAt.toISOString())
          .filter((slot) => availableSlots.includes(slot))
      : [];
    const freeSlots = await this.participantSlots(ctx, ctx.profile.id);
    return {
      slots: selected,
      freeSlots,
      bookedSlots: selected.filter((slot) => !freeSlots.includes(slot)),
      availableSlots,
    };
  }
  async saveAvailability(ctx: NetworkingContext, slots: string[]) {
    this.requireEnabled(ctx);
    const allowed = new Set(networkingSlots(ctx.config, ctx.event));
    const normalized = [
      ...new Set(slots.map((v) => new Date(v).toISOString())),
    ];
    if (normalized.some((v) => !allowed.has(v)))
      throw new BadRequestException(
        "Availability contains a slot outside event opening hours",
      );
    return networkingTransaction(ctx.event.id, async (store) => {
      ctx = await this.networking.currentParticipant(ctx, store);
      this.requireEnabled(ctx);
      const currentSlots = new Set(networkingSlots(ctx.config, ctx.event));
      if (normalized.some((slot) => !currentSlots.has(slot)))
        throw new BadRequestException(
          "Availability contains a slot outside event opening hours",
        );
      await store.remove("availability", {
        eventId: ctx.event.id,
        profileId: ctx.profile.id,
      });
      for (const slot of normalized)
        await store.insert("availability", {
          eventId: ctx.event.id,
          profileId: ctx.profile.id,
          startsAt: new Date(slot),
        });
      await store.update(
        "profiles",
        { eventId: ctx.event.id, id: ctx.profile.id },
        { availabilitySet: true },
      );
      return { slots: normalized };
    });
  }
  async hydrate(
    row: NetworkingRow<"meetings">,
    store = networkingStore(),
    admin = false,
    viewer?: NetworkingContext,
  ) {
    const [requester, recipient, table] = await Promise.all([
      store.one("profiles", { eventId: row.eventId, id: row.requesterId }),
      store.one("profiles", { eventId: row.eventId, id: row.recipientId }),
      row.tableId
        ? store.one("tables", { eventId: row.eventId, id: row.tableId })
        : null,
    ]);
    const space = table?.spaceId ? await store.one("spaces", { eventId: row.eventId, id: table.spaceId }) : null;
    const publicProfile = async (profile: typeof requester) => {
      if (!profile || admin) return profile;
      if (!viewer) return null;
      if (profile.id !== viewer.profile.id) {
        try { await this.networking.target(viewer, profile.id, store); }
        catch (error) {
          if (error instanceof NotFoundException) return null;
          throw error;
        }
      }
      return networkingPublicProfile(profile);
    };
    const [visibleRequester, visibleRecipient] = await Promise.all([
      publicProfile(requester), publicProfile(recipient),
    ]);
    return {
      ...row,
      requester: visibleRequester,
      recipient: visibleRecipient,
      table: table ? { ...table, space } : null,
    };
  }
  async expire(eventId: string) {
    return networkingTransaction(eventId, (_store, db) => expireNetworkingProposals(eventId, db));
  }
  async list(ctx: NetworkingContext) {
    await this.expire(ctx.event.id);
    const rows = await listNetworkingParticipantMeetings(ctx.event.id, ctx.profile.id);
    return {
      items: await Promise.all(rows.map((v) => this.hydrate(v, undefined, false, ctx))),
      total: rows.length,
    };
  }
  async meeting(ctx: NetworkingContext, id: string, store = networkingStore()) {
    const row = await store.one("meetings", { eventId: ctx.event.id, id });
    if (
      !row ||
      (row.requesterId !== ctx.profile.id && row.recipientId !== ctx.profile.id)
    )
      throw new NotFoundException("Meeting not found");
    return row;
  }
  slot(ctx: NetworkingContext, startsAt: string) {
    const start = new Date(startsAt);
    if (
      start <= new Date() ||
      !networkingSlots(ctx.config, ctx.event).includes(start.toISOString())
    )
      throw new BadRequestException(
        "Choose a future event slot within opening hours",
      );
    return {
      startsAt: start,
      endsAt: new Date(
        start.getTime() + ctx.config.slotDurationMinutes * 60_000,
      ),
    };
  }
  async availableAt(
    ctx: NetworkingContext,
    profileId: string,
    startsAt: Date,
    store: NetworkingStore,
  ) {
    const p = await store.one("profiles", {
      eventId: ctx.event.id,
      id: profileId,
    });
    if (
      !p ||
      !p.availabilitySet ||
      !p.meetingsEnabled ||
      !(await this.networking.eligible(p, ctx.config, store))
    )
      throw new ConflictException("Participant is unavailable");
    if (
      p.availabilitySet &&
      !(await store.one("availability", {
        eventId: ctx.event.id,
        profileId,
        startsAt,
      }))
    )
      throw new ConflictException("Participant is unavailable at this time");
  }
  async create(
    ctx: NetworkingContext,
    input: { profileId: string; startsAt: string; message?: string },
  ) {
    this.requireEnabled(ctx);
    const dates = this.slot(ctx, input.startsAt);
    return networkingTransaction(ctx.event.id, async (store, db) => {
      ctx = await this.networking.currentParticipant(ctx, store);
      this.requireEnabled(ctx);
      const dates = this.slot(ctx, input.startsAt);
      await this.networking.target(ctx, input.profileId, store);
      const [profileAId, profileBId] = networkingPair(
        ctx.profile.id,
        input.profileId,
      );
      if (
        !(await store.one("connections", {
          eventId: ctx.event.id,
          profileAId,
          profileBId,
        }))
      )
        throw new ForbiddenException(
          "A mutual connection is required before requesting a meeting",
        );
      await this.availableAt(ctx, ctx.profile.id, dates.startsAt, store);
      await this.availableAt(ctx, input.profileId, dates.startsAt, store);
      const same = (
        await store.all("meetings", { eventId: ctx.event.id })
      ).find(
        (m) =>
          ["PENDING", "CONFIRMED", "PENDING_ALLOCATION"].includes(m.status) &&
          m.startsAt.getTime() === dates.startsAt.getTime() &&
          [m.requesterId, m.recipientId].includes(ctx.profile.id) &&
          [m.requesterId, m.recipientId].includes(input.profileId),
      );
      if (same)
        throw new ConflictException(
          "A meeting already exists for this pair and slot",
        );
      let row = await store.insert("meetings", {
        eventId: ctx.event.id,
        requesterId: ctx.profile.id,
        recipientId: input.profileId,
        ...dates,
        message: input.message ?? "",
        expiresAt: new Date(
          Math.min(
            Date.now() + ctx.config.requestExpiryHours * 3_600_000,
            dates.startsAt.getTime(),
          ),
        ),
      });
      const hold = await this.reserve(ctx, row, dates.startsAt, dates.endsAt, store, undefined, true);
      [row] = await store.update("meetings", { eventId: ctx.event.id, id: row.id }, hold);
      await this.notify(ctx, row, "MEETING_REQUEST", [input.profileId], db);
      await this.notify(ctx, row, "MEETING_REQUEST_SENT", [ctx.profile.id], db);
      return this.hydrate(row, store, false, ctx);
    });
  }
  async reserve(
    ctx: NetworkingContext,
    row: NetworkingRow<"meetings">,
    startsAt: Date,
    endsAt: Date,
    store: NetworkingStore,
    forcedTableId?: string,
    pending = false,
  ) {
    if (row.status === "PENDING" && row.expiresAt <= new Date())
      throw new ConflictException("This proposal has expired");
    await this.availableAt(ctx, row.requesterId, startsAt, store);
    await this.availableAt(ctx, row.recipientId, startsAt, store);
    const meetings = await store.all("meetings", { eventId: ctx.event.id });
    // Expired proposals must not keep inventory locked until the next maintenance tick.
    for (const meeting of meetings) {
      if (meeting.status === "PENDING" && meeting.expiresAt <= new Date()) {
        await store.remove("reservations", { eventId: ctx.event.id, meetingId: meeting.id });
        await store.update("meetings", { eventId: ctx.event.id, id: meeting.id }, {
          status: "EXPIRED", revision: meeting.revision + 1,
        });
      }
    }
    const quanta = resourceQuanta(startsAt, endsAt);
    const reservations = (
      await store.all("reservations", { eventId: ctx.event.id })
    ).filter((v) => v.meetingId !== row.id);
    const occupied = new Set(reservations.map(reservation => `${reservation.resourceKey}:${reservation.startsAt.getTime()}`));
    const taken = (key: string) => quanta.some(quantum => occupied.has(`${key}:${quantum.getTime()}`));
    const participantKeys = [
      `profile:${row.requesterId}`,
      `profile:${row.recipientId}`,
    ];
    if (participantKeys.some(taken))
      throw new ConflictException(
        "One of the participants already has a meeting in this slot",
      );
    const [requester, recipient, spaces] = await Promise.all([
      store.one("profiles", { eventId: ctx.event.id, id: row.requesterId }),
      store.one("profiles", { eventId: ctx.event.id, id: row.recipientId }),
      store.all("spaces", { eventId: ctx.event.id }),
    ]);
    if (!requester || !recipient) throw new NotFoundException("Participant not found");
    const bySpace = new Map(spaces.map(space => [space.id, space]));
    let tableId: string | null = null;
    let inventoryResource: string | null = null;
    if (ctx.config.autoAssignTables || forcedTableId) {
      let tables = (
        await store.all("tables", { eventId: ctx.event.id, active: true })
      ).filter(
        (t) =>
          (!t.spaceId || bySpace.get(t.spaceId)?.active === true) &&
          !!networkingInventoryResource(t, [requester, recipient]) &&
          !taken(networkingInventoryResource(t, [requester, recipient])!) &&
          !taken(`table:${t.id}`),
      );
      const assignedStand =
        forcedTableId ?? recipient.standTableId ?? requester.standTableId;
      if (assignedStand) tables = tables.filter((t) => t.id === assignedStand);
      // Ordinary tables are exclusive; each exhibitor representative has an independent station.
      const usage = new Map<string, number>();
      for (const meeting of meetings) if (meeting.tableId && ["PENDING", "CONFIRMED", "PENDING_ALLOCATION", "COMPLETED"].includes(meeting.status))
        usage.set(meeting.tableId, (usage.get(meeting.tableId) ?? 0) + 1);
      tables.sort((a, b) => Number(b.id === row.tableId) - Number(a.id === row.tableId) || (usage.get(a.id) ?? 0) - (usage.get(b.id) ?? 0) || a.name.localeCompare(b.name));
      tableId = tables[0]?.id ?? null;
      inventoryResource = tables[0] ? networkingInventoryResource(tables[0], [requester, recipient]) : null;
      if (!tableId)
        throw new ConflictException(
          "No table or exhibitor representative is available for this slot; choose another time",
        );
    }
    await store.remove("reservations", {
      eventId: ctx.event.id,
      meetingId: row.id,
    });
    for (const resourceKey of [
      ...(pending ? [] : participantKeys),
      ...(inventoryResource ? [inventoryResource] : []),
    ])
      for (const start of quanta)
        await store.insert("reservations", {
          eventId: ctx.event.id,
          meetingId: row.id,
          resourceKey,
          startsAt: start,
        });
    return {
      tableId,
      status: pending ? ("PENDING" as const) : tableId
        ? ("CONFIRMED" as const)
        : ("PENDING_ALLOCATION" as const),
    };
  }
  async respond(
    ctx: NetworkingContext,
    id: string,
    input: {
      action: "ACCEPT" | "DECLINE" | "CANCEL" | "RESCHEDULE";
      startsAt?: string;
      message?: string;
    },
  ) {
    if (input.action !== "CANCEL") this.requireEnabled(ctx);
    return networkingTransaction(ctx.event.id, async (store, db) => {
      ctx = await this.networking.currentParticipant(ctx, store);
      if (input.action !== "CANCEL") this.requireEnabled(ctx);
      const row = await this.meeting(ctx, id, store);
      if (!["PENDING", "CONFIRMED", "PENDING_ALLOCATION"].includes(row.status))
        throw new ConflictException("This meeting can no longer be changed");
      await this.networking.target(
        ctx,
        row.requesterId === ctx.profile.id ? row.recipientId : row.requesterId,
        store,
      );
      if (row.status === "PENDING" && row.expiresAt <= new Date())
        throw new ConflictException("This proposal has expired");
      const proposalEnd = row.proposedStartsAt
        ? new Date(
            row.proposedStartsAt.getTime() +
              ctx.config.slotDurationMinutes * 60_000,
          )
        : row.endsAt;
      if (proposalEnd <= new Date())
        throw new ConflictException("This meeting has already ended");
      let update: Partial<NetworkingRow<"meetings">> = {
        revision: row.revision + 1,
      };
      if (input.action === "CANCEL") {
        update = {
          ...update,
          status: "CANCELLED",
          cancellationNote: input.message?.trim() ?? "",
          proposedStartsAt: null,
          proposalBy: null,
        };
        await store.remove("reservations", {
          eventId: ctx.event.id,
          meetingId: id,
        });
      } else if (input.action === "RESCHEDULE") {
        const dates = this.slot(ctx, input.startsAt!);
        await this.availableAt(ctx, row.requesterId, dates.startsAt, store);
        await this.availableAt(ctx, row.recipientId, dates.startsAt, store);
        const hold = row.status === "PENDING"
          ? await this.reserve(ctx, row, dates.startsAt, dates.endsAt, store, undefined, true)
          : {};
        update = {
          ...update,
          ...hold,
          ...(row.status === "PENDING" ? dates : {}),
          proposedStartsAt: dates.startsAt,
          proposalBy: ctx.profile.id,
          expiresAt: new Date(
            Math.min(
              Date.now() + ctx.config.requestExpiryHours * 3_600_000,
              dates.startsAt.getTime(),
            ),
          ),
          ...(input.message !== undefined ? { message: input.message } : {}),
        };
      } else {
        const proposer = row.proposalBy ?? row.requesterId;
        if (proposer === ctx.profile.id)
          throw new ForbiddenException(
            "Only the other participant can respond to this proposal",
          );
        if (!row.proposedStartsAt && row.status !== "PENDING")
          throw new ConflictException("No proposal is awaiting a response");
        if (row.expiresAt <= new Date())
          throw new ConflictException("This proposal has expired");
        if (input.action === "DECLINE") {
          if (row.status === "PENDING")
            await store.remove("reservations", { eventId: ctx.event.id, meetingId: id });
          update = {
            ...update,
            ...(row.status === "PENDING"
              ? { status: "DECLINED" as const }
              : {}),
            proposedStartsAt: null,
            proposalBy: null,
          };
        } else {
          const dates = this.slot(
            ctx,
            (row.proposedStartsAt ?? row.startsAt).toISOString(),
          );
          const allocation = await this.reserve(
            ctx,
            row,
            dates.startsAt,
            dates.endsAt,
            store,
          );
          update = {
            ...update,
            ...dates,
            ...allocation,
            proposedStartsAt: null,
            proposalBy: null,
          };
        }
      }
      const [saved] = await store.update(
        "meetings",
        { eventId: ctx.event.id, id },
        update,
      );
      await this.notify(
        ctx,
        saved,
        `MEETING_${input.action}`,
        [row.requesterId, row.recipientId],
        db,
      );
      return this.hydrate(saved, store, false, ctx);
    });
  }
  async notify(
    ctx: Pick<NetworkingContext, "event">,
    row: NetworkingRow<"meetings">,
    type: string,
    profileIds: string[],
    db: DbExecutor,
  ) {
    for (const profileId of profileIds)
      await createNetworkingNotification(
        {
          eventId: row.eventId,
          profileId,
          type,
          title: "Meeting update",
          body: `Meeting ${row.status.toLowerCase().replaceAll("_", " ")} for ${row.startsAt.toISOString()}.`,
          href: `/${ctx.event.slug}/agenda`,
          data: {
            meetingId: row.id,
            revision: row.revision,
            startsAt: row.startsAt.toISOString(),
            status: row.status,
          },
        },
        db,
      );
  }
  async checkin(ctx: NetworkingContext, id: string, token: string) {
    return networkingTransaction(ctx.event.id, async (store) => {
      ctx = await this.networking.currentParticipant(ctx, store);
      const row = await this.meeting(ctx, id, store);
      const counterpart = await this.networking.badgeProfileId(ctx.event.id, token, store);
      const other =
        row.requesterId === ctx.profile.id ? row.recipientId : row.requesterId;
      if (counterpart !== other)
        throw new BadRequestException({
          code: "NETWORKING_BADGE_WRONG_PARTICIPANT",
          message: "Scan your meeting partner’s badge",
        });
      await this.networking.target(ctx, other, store);
      if (row.status !== "CONFIRMED" && row.status !== "COMPLETED")
        throw new ConflictException({
          code: "NETWORKING_MEETING_CHECKIN_UNCONFIRMED",
          message: "Only confirmed meetings support check-in",
        });
      if (
        Date.now() < row.startsAt.getTime() - 30 * 60_000 ||
        Date.now() > row.endsAt.getTime() + 12 * 3_600_000
      )
        throw new BadRequestException({
          code: "NETWORKING_MEETING_CHECKIN_UNAVAILABLE",
          message: "Check-in is not available at this time",
        });
      const ownKey =
        row.requesterId === ctx.profile.id
          ? "requesterCheckedInAt"
          : "recipientCheckedInAt";
      const otherChecked =
        row.requesterId === ctx.profile.id
          ? row.recipientCheckedInAt
          : row.requesterCheckedInAt;
      const [saved] = await store.update(
        "meetings",
        { eventId: ctx.event.id, id },
        {
          [ownKey]: row[ownKey] ?? new Date(),
          ...(otherChecked ? { status: "COMPLETED" as const } : {}),
          revision: row.revision + 1,
        },
      );
      return this.hydrate(saved, store, false, ctx);
    });
  }
}
