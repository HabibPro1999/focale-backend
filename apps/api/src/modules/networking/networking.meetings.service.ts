import { ErrorCodes, type NetworkingParticipantListQuery } from "@app/contracts";
import { participantPagination } from "./networking.pagination";
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
  countNetworkingParticipantMeetings,
  networkingStore,
  networkingTransaction,
  pgUniqueViolation,
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
const actions: Record<string, string> = {
  MEETING_REQUEST: "REQUEST", MEETING_REQUEST_SENT: "REQUEST", MEETING_ACCEPT: "ACCEPT", MEETING_DECLINE: "DECLINE",
  MEETING_CANCEL: "CANCEL", MEETING_CANCELLED: "CANCEL", MEETING_RESCHEDULE: "RESCHEDULE", MEETING_ASSIGN: "ASSIGN",
  MEETING_COMPLETED: "COMPLETED", MEETING_NO_SHOW: "NO_SHOW",
};
@Injectable()
export class NetworkingMeetingsService {
  constructor(private readonly networking: NetworkingService) {}
  requireEnabled(ctx: NetworkingContext) {
    if (!ctx.config.meetingsEnabled || !ctx.profile.meetingsEnabled)
      throw new ForbiddenException({ code: "NETWORKING_FEATURE_DISABLED", message: "Meetings are disabled" });
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
    const booked = availableSlots.length ? await store.allocationReservations(
      ctx.event.id, new Date(Math.floor(Date.parse(availableSlots[0]) / 300_000) * 300_000),
      new Date(Date.parse(availableSlots[availableSlots.length - 1]) + ctx.config.slotDurationMinutes * 60_000),
      `profile:${profileId}`,
    ) : [];
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
      throw new BadRequestException({ code: "NETWORKING_SLOT_INVALID", message: "Availability contains a slot outside event opening hours" });
    return networkingTransaction(ctx.event.id, async (store) => {
      ctx = await this.networking.currentParticipant(ctx, store);
      this.requireEnabled(ctx);
      const currentSlots = new Set(networkingSlots(ctx.config, ctx.event));
      if (normalized.some((slot) => !currentSlots.has(slot)))
        throw new BadRequestException({ code: "NETWORKING_SLOT_INVALID", message: "Availability contains a slot outside event opening hours" });
      await store.remove("availability", {
        eventId: ctx.event.id,
        profileId: ctx.profile.id,
      });
      await store.insertAvailability(normalized.map(slot => ({
          eventId: ctx.event.id,
          profileId: ctx.profile.id,
          startsAt: new Date(slot),
        })));
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
    relations?: {
      requester: NetworkingRow<"profiles"> | null;
      recipient: NetworkingRow<"profiles"> | null;
      table: (NetworkingRow<"tables"> & { representativeIds?: string[]; representatives?: Pick<NetworkingRow<"profiles">, "id" | "firstName" | "lastName" | "company">[] }) | null;
      space: NetworkingRow<"spaces"> | null;
    },
  ) {
    const [requester, recipient, table] = relations
      ? [relations.requester, relations.recipient, relations.table]
      : await Promise.all([
      store.one("profiles", { eventId: row.eventId, id: row.requesterId }),
      store.one("profiles", { eventId: row.eventId, id: row.recipientId }),
      row.tableId
        ? store.one("tables", { eventId: row.eventId, id: row.tableId })
        : null,
    ]);
    const space = relations ? relations.space : table?.spaceId ? await store.one("spaces", { eventId: row.eventId, id: table.spaceId }) : null;
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
  async hydrateCalendar(eventId: string, rows: NetworkingRow<"meetings">[]) {
    if (!rows.length) return [];
    const store = networkingStore();
    const relations = await store.calendarRelations(eventId, rows);
    const profiles = new Map(relations.profiles.map(profile => [profile.id, profile]));
    const spaces = new Map(relations.spaces.map(space => [space.id, space]));
    const representatives = new Map<string, typeof relations.profiles>();
    for (const profile of relations.profiles) {
      if (!profile.standTableId) continue;
      const group = representatives.get(profile.standTableId) ?? [];
      group.push(profile);
      representatives.set(profile.standTableId, group);
    }
    const tables = new Map(relations.tables.map(table => {
      const members = [...(representatives.get(table.id) ?? [])];
      const owner = table.ownerProfileId ? profiles.get(table.ownerProfileId) : undefined;
      if (owner && !members.some(profile => profile.id === owner.id)) members.push(owner);
      return [table.id, { ...table, representativeIds: members.map(profile => profile.id),
        representatives: members.map(({ id, firstName, lastName, company }) => ({ id, firstName, lastName, company })) }];
    }));
    return Promise.all(rows.map(row => {
      const table = row.tableId ? tables.get(row.tableId) ?? null : null;
      return this.hydrate(row, store, true, undefined, {
        requester: profiles.get(row.requesterId) ?? null,
        recipient: profiles.get(row.recipientId) ?? null,
        table, space: table?.spaceId ? spaces.get(table.spaceId) ?? null : null,
      });
    }));
  }
  /** Idempotent single statements: no event lock is needed on read paths. */
  async expire(eventId: string) {
    await expireNetworkingProposals(eventId);
  }
  async list(ctx: NetworkingContext, query: NetworkingParticipantListQuery = {}) {
    const page = participantPagination("meetings", ctx, query);
    if (!page.after) await this.expire(ctx.event.id);
    const rows = await listNetworkingParticipantMeetings(ctx.event.id, ctx.profile.id, page);
    const visibleRows = rows.slice(0, page.limit);
    const last = visibleRows.at(-1);
    return {
      items: await Promise.all(visibleRows.map((v) => this.hydrate(v, undefined, false, ctx))),
      nextCursor: rows.length > page.limit && last ? page.cursor(last.startsAt, last.id) : null,
      ...(page.after ? {} : { total: await countNetworkingParticipantMeetings(ctx.event.id, ctx.profile.id) }),
    };
  }
  /** Internal, unpaginated: exports must never be truncated. Not exposed over HTTP. */
  async allMeetings(ctx: NetworkingContext) {
    await this.expire(ctx.event.id);
    const rows = await listNetworkingParticipantMeetings(ctx.event.id, ctx.profile.id);
    return Promise.all(rows.map((v) => this.hydrate(v, undefined, false, ctx)));
  }
  /** One own meeting, same hydrated shape as a GET meetings item (K2). */
  async get(ctx: NetworkingContext, id: string) {
    await this.expire(ctx.event.id);
    const store = networkingStore();
    return this.hydrate(await this.meeting(ctx, id, store), store, false, ctx);
  }
  async meeting(ctx: NetworkingContext, id: string, store = networkingStore()) {
    const row = await store.one("meetings", { eventId: ctx.event.id, id });
    if (
      !row ||
      (row.requesterId !== ctx.profile.id && row.recipientId !== ctx.profile.id)
    )
      throw new NotFoundException({ code: ErrorCodes.NETWORKING_NOT_FOUND, message: "Meeting not found" });
    return row;
  }
  slot(ctx: NetworkingContext, startsAt: string) {
    const start = new Date(startsAt);
    if (
      start <= new Date() ||
      !networkingSlots(ctx.config, ctx.event).includes(start.toISOString())
    )
      throw new BadRequestException({ code: "NETWORKING_SLOT_INVALID", message: "Choose a future event slot within opening hours" });
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
      throw new ConflictException({ code: "NETWORKING_SLOT_CONFLICT", message: "Participant is unavailable" });
    if (
      p.availabilitySet &&
      !(await store.one("availability", {
        eventId: ctx.event.id,
        profileId,
        startsAt,
      }))
    )
      throw new ConflictException({ code: "NETWORKING_SLOT_CONFLICT", message: "Participant is unavailable at this time" });
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
        throw new ForbiddenException({ code: "NETWORKING_CONNECTION_REQUIRED", message: "A mutual connection is required before requesting a meeting" });
      await this.availableAt(ctx, ctx.profile.id, dates.startsAt, store);
      await this.availableAt(ctx, input.profileId, dates.startsAt, store);
      const same = (
        await store.allocationMeetings(ctx.event.id, dates.startsAt, dates.endsAt)
      ).find(
        (m) =>
          ["PENDING", "CONFIRMED", "PENDING_ALLOCATION"].includes(m.status) &&
          m.startsAt.getTime() === dates.startsAt.getTime() &&
          [m.requesterId, m.recipientId].includes(ctx.profile.id) &&
          [m.requesterId, m.recipientId].includes(input.profileId),
      );
      if (same)
        throw new ConflictException({ code: "NETWORKING_SLOT_CONFLICT", message: "A meeting already exists for this pair and slot" });
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
      throw new ConflictException({ code: "NETWORKING_MEETING_LOCKED", message: "This proposal has expired" });
    await this.availableAt(ctx, row.requesterId, startsAt, store);
    await this.availableAt(ctx, row.recipientId, startsAt, store);
    const quanta = resourceQuanta(startsAt, endsAt);
    const meetings = await store.allocationMeetings(ctx.event.id, quanta[0], endsAt);
    // Expired proposals must not keep inventory locked until the next maintenance tick.
    for (const meeting of meetings) {
      if (meeting.status === "PENDING" && meeting.expiresAt <= new Date()) {
        await store.remove("reservations", { eventId: ctx.event.id, meetingId: meeting.id });
        await store.update("meetings", { eventId: ctx.event.id, id: meeting.id }, {
          status: "EXPIRED", revision: meeting.revision + 1,
        });
      }
    }
    const reservations = (
      await store.allocationReservations(ctx.event.id, quanta[0], endsAt)
    ).filter((v) => v.meetingId !== row.id);
    const occupied = new Set(reservations.map(reservation => `${reservation.resourceKey}:${reservation.startsAt.getTime()}`));
    const taken = (key: string) => quanta.some(quantum => occupied.has(`${key}:${quantum.getTime()}`));
    const participantKeys = [
      `profile:${row.requesterId}`,
      `profile:${row.recipientId}`,
    ];
    if (participantKeys.some(taken))
      throw new ConflictException({ code: "NETWORKING_SLOT_CONFLICT", message: "One of the participants already has a meeting in this slot" });
    const [requester, recipient, spaces] = await Promise.all([
      store.one("profiles", { eventId: ctx.event.id, id: row.requesterId }),
      store.one("profiles", { eventId: ctx.event.id, id: row.recipientId }),
      store.all("spaces", { eventId: ctx.event.id }),
    ]);
    if (!requester || !recipient) throw new NotFoundException({ code: ErrorCodes.NETWORKING_NOT_FOUND, message: "Participant not found" });
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
      for (const entry of await store.allocationTableUsage(ctx.event.id))
        if (entry.tableId) usage.set(entry.tableId, entry.count);
      tables.sort((a, b) => Number(b.id === row.tableId) - Number(a.id === row.tableId) || (usage.get(a.id) ?? 0) - (usage.get(b.id) ?? 0) || a.name.localeCompare(b.name));
      tableId = tables[0]?.id ?? null;
      inventoryResource = tables[0] ? networkingInventoryResource(tables[0], [requester, recipient]) : null;
      if (!tableId)
        throw new ConflictException({ code: "NETWORKING_SLOT_CONFLICT", message: "No table or exhibitor representative is available for this slot; choose another time" });
    }
    await store.remove("reservations", {
      eventId: ctx.event.id,
      meetingId: row.id,
    });
    try {
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
    } catch (error) {
      // A concurrent booking won the unique resource/time reservation.
      if (pgUniqueViolation(error))
        throw new ConflictException({ code: ErrorCodes.NETWORKING_SLOT_CONFLICT, message: "This slot was just booked; choose another time" });
      throw error;
    }
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
      if (["RESCHEDULE", "ACCEPT"].includes(input.action) && (row.requesterCheckedInAt || row.recipientCheckedInAt))
        throw new ConflictException({ code: "NETWORKING_MEETING_CHECKED_IN", message: "A checked-in meeting cannot be rescheduled" });
      if (!["PENDING", "CONFIRMED", "PENDING_ALLOCATION"].includes(row.status))
        throw new ConflictException({ code: "NETWORKING_MEETING_LOCKED", message: "This meeting can no longer be changed" });
      await this.networking.target(
        ctx,
        row.requesterId === ctx.profile.id ? row.recipientId : row.requesterId,
        store,
      );
      if (row.status === "PENDING" && row.expiresAt <= new Date())
        throw new ConflictException({ code: "NETWORKING_MEETING_LOCKED", message: "This proposal has expired" });
      const proposalEnd = row.proposedStartsAt
        ? new Date(
            row.proposedStartsAt.getTime() +
              ctx.config.slotDurationMinutes * 60_000,
          )
        : row.endsAt;
      if (proposalEnd <= new Date())
        throw new ConflictException({ code: "NETWORKING_MEETING_LOCKED", message: "This meeting has already ended" });
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
          ...(input.message?.trim() ? { message: input.message } : {}),
        };
      } else {
        const proposer = row.proposalBy ?? row.requesterId;
        if (proposer === ctx.profile.id)
          throw new ForbiddenException({ code: ErrorCodes.NETWORKING_ACTION_NOT_ALLOWED, message: "Only the other participant can respond to this proposal" });
        if (!row.proposedStartsAt && row.status !== "PENDING")
          throw new ConflictException({ code: "NETWORKING_MEETING_LOCKED", message: "No proposal is awaiting a response" });
        if (row.expiresAt <= new Date())
          throw new ConflictException({ code: "NETWORKING_MEETING_LOCKED", message: "This proposal has expired" });
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
  /** `counterpart: false` for block/withdrawal/moderation cancellations, which never name the other side (K5). */
  async notify(
    ctx: Pick<NetworkingContext, "event">,
    row: NetworkingRow<"meetings">,
    type: string,
    profileIds: string[],
    db: DbExecutor,
    options: { counterpart?: boolean } = {},
  ) {
    const store = networkingStore(db);
    const proposedEndsAt = row.proposedStartsAt
      ? new Date(row.proposedStartsAt.getTime() + row.endsAt.getTime() - row.startsAt.getTime())
      : null;
    const table = row.tableId ? await store.one("tables", { eventId: row.eventId, id: row.tableId }) : null;
    const space = table?.spaceId ? await store.one("spaces", { eventId: row.eventId, id: table.spaceId }) : null;
    for (const profileId of profileIds) {
      const counterpart = options.counterpart === false ? null : await store.one("profiles", {
        eventId: row.eventId,
        id: profileId === row.requesterId ? row.recipientId : row.requesterId,
      });
      await createNetworkingNotification(
        {
          eventId: row.eventId,
          profileId,
          type,
          title: "Meeting update",
          body: `Meeting ${row.status.toLowerCase().replaceAll("_", " ")} for ${row.startsAt.toISOString()}.`,
          href: `/e/${ctx.event.slug}/agenda`,
          data: {
            meetingId: row.id,
            revision: row.revision,
            ...(actions[type] ? { action: actions[type] } : {}),
            startsAt: row.startsAt.toISOString(),
            endsAt: row.endsAt.toISOString(),
            ...(row.proposedStartsAt && proposedEndsAt
              ? { proposedStartsAt: row.proposedStartsAt.toISOString(), proposedEndsAt: proposedEndsAt.toISOString() }
              : {}),
            ...(counterpart ? { counterpartName: `${counterpart.firstName} ${counterpart.lastName}`.trim() } : {}),
            ...(table ? { tableName: table.name } : {}),
            ...(space ? { spaceName: space.name } : {}),
            status: row.status,
          },
        },
        db,
      );
    }
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
          // Once anyone has checked in, a pending counter-proposal can no longer move the meeting.
          proposedStartsAt: null,
          proposalBy: null,
          revision: row.revision + 1,
        },
      );
      return this.hydrate(saved, store, false, ctx);
    });
  }
}
