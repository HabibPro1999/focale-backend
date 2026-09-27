import {
  networkingNotFound,
  networkingFeatureDisabled,
  networkingLocked,
  networkingSlotConflict,
} from "./networking.errors";
import { activeStand } from "./networking.stand";
import {
  futureNetworkingSlots,
  networkingSlotEnd,
  networkingProposalExpiry,
  networkingPair,
  networkingPublicProfile,
  networkingSlots,
  resourceQuanta,
} from "./networking.policy";
import {
  NETWORKING_OPEN_MEETING_STATUSES,
  ErrorCodes,
  type NetworkingParticipantListQuery,
  type NetworkingConfig,
} from "@app/contracts";

import { participantPagination, toParticipantPage } from "./networking.pagination";
import { BadRequestException, ConflictException, ForbiddenException, Injectable } from "@nestjs/common";
import {
  createNetworkingNotification,
  expireNetworkingProposals,
  getNetworkingConfig,
  listNetworkingParticipantMeetings,
  countNetworkingParticipantMeetings,
  networkingAllocationTransaction,
  NetworkingAllocationLockError,
  NetworkingBusyError,
  networkingStore,
  networkingTransaction,
  type NetworkingInterval,
  type NetworkingRow,
  type NetworkingStore,
  type DbExecutor,
} from "@app/db";

import { NetworkingService, type NetworkingContext } from "./networking.service";

import { networkingInventoryResource } from "./networking.inventory-policy";
/** Re-plans after the meeting moved between the lock plan's read and the lock. */
const ALLOCATION_PLAN_ATTEMPTS = 3;
/** The slot a meeting would occupy from `start`, or none when `start` is not a valid instant. */
function slotInterval(start: Date | string | null | undefined, config: Pick<NetworkingConfig, "slotDurationMinutes">): NetworkingInterval[] {
  const startsAt = start ? new Date(start) : null;
  if (!startsAt || !Number.isFinite(startsAt.getTime())) return [];
  return [{ startsAt, endsAt: networkingSlotEnd(startsAt, config) }];
}
const actions = {
  MEETING_REQUEST: "REQUEST", MEETING_REQUEST_SENT: "REQUEST", MEETING_ACCEPT: "ACCEPT", MEETING_DECLINE: "DECLINE",
  MEETING_CANCEL: "CANCEL", MEETING_CANCELLED: "CANCEL", MEETING_RESCHEDULE: "RESCHEDULE", MEETING_ASSIGN: "ASSIGN",
  MEETING_COMPLETED: "COMPLETED", MEETING_NO_SHOW: "NO_SHOW",
};
type MeetingRelations = {
  requester: NetworkingRow<"profiles"> | null;
  recipient: NetworkingRow<"profiles"> | null;
  table: (NetworkingRow<"tables"> & {
    representativeIds?: string[];
    representatives?: Pick<NetworkingRow<"profiles">, "id" | "firstName" | "lastName" | "company">[];
  }) | null;
  space: NetworkingRow<"spaces"> | null;
};
@Injectable()
export class NetworkingMeetingsService {
  constructor(private readonly networking: NetworkingService) {}
  requireEnabled(ctx: NetworkingContext) {
    if (!ctx.config.meetingsEnabled || !ctx.profile.meetingsEnabled)
      throw networkingFeatureDisabled("Meetings are disabled");
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
      if (!(await activeStand(store, ctx.event.id, profile.standTableId))) return [];
    }
    const availableSlots = futureNetworkingSlots(ctx.config, ctx.event);
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
      networkingSlotEnd(new Date(availableSlots[availableSlots.length - 1]), ctx.config),
      `profile:${profileId}`,
    ) : [];
    return availableSlots.filter(
      (v) =>
        own.has(v) &&
        !resourceQuanta(
          new Date(v),
          networkingSlotEnd(new Date(v), ctx.config),
        ).some((q) => booked.some((b) => b.startsAt.getTime() === q.getTime())),
    );
  }
  async availability(ctx: NetworkingContext) {
    this.requireEnabled(ctx);
    const availableSlots = futureNetworkingSlots(ctx.config, ctx.event);
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
      throw new BadRequestException({ code: ErrorCodes.NETWORKING_SLOT_INVALID, message: "Availability contains a slot outside event opening hours" });
    return networkingTransaction(ctx.event.id, async (store) => {
      ctx = await this.networking.currentParticipant(ctx, store);
      this.requireEnabled(ctx);
      const currentSlots = new Set(networkingSlots(ctx.config, ctx.event));
      if (normalized.some((slot) => !currentSlots.has(slot)))
        throw new BadRequestException({ code: ErrorCodes.NETWORKING_SLOT_INVALID, message: "Availability contains a slot outside event opening hours" });
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
  hydrateForViewer(row: NetworkingRow<"meetings">, viewer: NetworkingContext, store = networkingStore()) {
    return this.hydrate(row, store, { viewer });
  }
  hydrateForAdmin(row: NetworkingRow<"meetings">, store = networkingStore(), relations?: MeetingRelations) {
    return this.hydrate(row, store, { admin: true }, relations);
  }
  private async hydrate(
    row: NetworkingRow<"meetings">,
    store: NetworkingStore,
    audience: { viewer: NetworkingContext } | { admin: true },
    relations?: MeetingRelations,
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
      if (!profile || "admin" in audience) return profile;
      const viewer = audience.viewer;
      if (profile.id !== viewer.profile.id) {
        if (!(await this.networking.findCounterpart(viewer, profile.id, store))) return null;
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
      return this.hydrateForAdmin(row, store, {
        requester: profiles.get(row.requesterId) ?? null,
        recipient: profiles.get(row.recipientId) ?? null,
        table, space: table?.spaceId ? spaces.get(table.spaceId) ?? null : null,
      });
    }));
  }
  /** Idempotent single statements: read paths need no transaction. */
  async expire(eventId: string) {
    await expireNetworkingProposals(eventId);
  }
  async list(ctx: NetworkingContext, query: NetworkingParticipantListQuery = {}) {
    const page = participantPagination("meetings", ctx, query);
    if (!page.after) await this.expire(ctx.event.id);
    const rows = await listNetworkingParticipantMeetings(ctx.event.id, ctx.profile.id, page);
    return toParticipantPage(page, rows, (row) => row.startsAt,
      (items) => Promise.all(items.map((v) => this.hydrateForViewer(v, ctx))),
      () => countNetworkingParticipantMeetings(ctx.event.id, ctx.profile.id));
  }
  /** Internal, unpaginated: exports must never be truncated. Not exposed over HTTP. */
  async allMeetings(ctx: NetworkingContext) {
    await this.expire(ctx.event.id);
    const rows = await listNetworkingParticipantMeetings(ctx.event.id, ctx.profile.id);
    return Promise.all(rows.map((v) => this.hydrateForViewer(v, ctx)));
  }
  /** One own meeting, same hydrated shape as a GET meetings item (K2). */
  async get(ctx: NetworkingContext, id: string) {
    await this.expire(ctx.event.id);
    const store = networkingStore();
    return this.hydrateForViewer(await this.meeting(ctx, id, store), ctx, store);
  }
  async meeting(ctx: NetworkingContext, id: string, store = networkingStore()) {
    const row = await store.one("meetings", { eventId: ctx.event.id, id });
    if (
      !row ||
      (row.requesterId !== ctx.profile.id && row.recipientId !== ctx.profile.id)
    )
      throw networkingNotFound("Meeting not found");
    return row;
  }
  slot(ctx: NetworkingContext, startsAt: string) {
    const start = new Date(startsAt);
    if (
      start <= new Date() ||
      !networkingSlots(ctx.config, ctx.event).includes(start.toISOString())
    )
      throw new BadRequestException({ code: ErrorCodes.NETWORKING_SLOT_INVALID, message: "Choose a future event slot within opening hours" });
    return {
      startsAt: start,
      endsAt: networkingSlotEnd(start, ctx.config),
    };
  }
  async availableAt(
    ctx: Pick<NetworkingContext, "event" | "config">,
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
      throw networkingSlotConflict("Participant is unavailable");
    if (
      p.availabilitySet &&
      !(await store.one("availability", {
        eventId: ctx.event.id,
        profileId,
        startsAt,
      }))
    )
      throw networkingSlotConflict("Participant is unavailable at this time");
  }
  async create(
    ctx: NetworkingContext,
    input: { profileId: string; startsAt: string; message?: string },
  ) {
    this.requireEnabled(ctx);
    this.slot(ctx, input.startsAt);
    return this.allocation(
      ctx.event.id,
      async (fresh) => slotInterval(input.startsAt, (await fresh()) ?? ctx.config),
      async (store, db) => {
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
          throw new ForbiddenException({ code: ErrorCodes.NETWORKING_CONNECTION_REQUIRED, message: "A mutual connection is required before requesting a meeting" });
        await this.availableAt(ctx, ctx.profile.id, dates.startsAt, store);
        await this.availableAt(ctx, input.profileId, dates.startsAt, store);
        const same = (
          await store.allocationMeetings(ctx.event.id, dates.startsAt, dates.endsAt)
        ).find(
          (m) =>
            NETWORKING_OPEN_MEETING_STATUSES.includes(m.status) &&
            m.startsAt.getTime() === dates.startsAt.getTime() &&
            [m.requesterId, m.recipientId].includes(ctx.profile.id) &&
            [m.requesterId, m.recipientId].includes(input.profileId),
        );
        if (same)
          throw networkingSlotConflict("A meeting already exists for this pair and slot");
        let row = await store.insert("meetings", {
          eventId: ctx.event.id,
          requesterId: ctx.profile.id,
          recipientId: input.profileId,
          ...dates,
          message: input.message ?? "",
          expiresAt: networkingProposalExpiry(dates.startsAt, ctx.config),
        });
        const hold = await this.reserve(ctx, row, dates.startsAt, dates.endsAt, store, { hold: true });
        [row] = await store.update("meetings", { eventId: ctx.event.id, id: row.id }, hold);
        await this.notify(ctx, row, "MEETING_REQUEST", [input.profileId], db);
        await this.notify(ctx, row, "MEETING_REQUEST_SENT", [ctx.profile.id], db);
        return this.hydrateForViewer(row, ctx, store);
      },
    );
  }
  /**
   * Run a write that may claim resources under the hour locks `plan` derives
   * from a fresh read (no lock when it returns none). A claim outside those
   * hours means the meeting or slot duration moved in between: re-plan, with
   * `fresh()` then returning the current config.
   */
  async allocation<T>(
    eventId: string,
    plan: (fresh: () => Promise<NetworkingConfig | null>) => Promise<NetworkingInterval[]>,
    run: (store: NetworkingStore, db: DbExecutor) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const intervals = await plan(async () => (attempt === 1 ? null : getNetworkingConfig(eventId)));
      try {
        return intervals.length
          ? await networkingAllocationTransaction(eventId, intervals, run)
          : await networkingTransaction(eventId, run);
      } catch (error) {
        if (!(error instanceof NetworkingAllocationLockError)) throw error;
        if (attempt >= ALLOCATION_PLAN_ATTEMPTS) throw new NetworkingBusyError({ cause: error });
      }
    }
  }
  async reserve(
    ctx: Pick<NetworkingContext, "event" | "config">,
    row: NetworkingRow<"meetings">,
    startsAt: Date,
    endsAt: Date,
    store: NetworkingStore,
    { forcedTableId, hold: pending = false }: { forcedTableId?: string; hold?: boolean } = {},
  ) {
    if (row.status === "PENDING" && row.expiresAt <= new Date())
      throw networkingLocked("This proposal has expired");
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
    const participantBusy = () =>
      networkingSlotConflict("One of the participants already has a meeting in this slot");
    const noTable = () =>
      networkingSlotConflict("No table or exhibitor representative is available for this slot; choose another time");
    if (participantKeys.some(taken)) throw participantBusy();
    const [requester, recipient, spaces] = await Promise.all([
      store.one("profiles", { eventId: ctx.event.id, id: row.requesterId }),
      store.one("profiles", { eventId: ctx.event.id, id: row.recipientId }),
      store.all("spaces", { eventId: ctx.event.id }),
    ]);
    if (!requester || !recipient) throw networkingNotFound("Participant not found");
    const bySpace = new Map(spaces.map(space => [space.id, space]));
    let candidates: NetworkingRow<"tables">[] = [];
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
      // Spread order: the meeting's current table, then the least used; each exhibitor
      // representative has an independent station, ordinary tables are exclusive.
      const usage = new Map<string, number>();
      for (const entry of await store.allocationTableUsage(ctx.event.id))
        if (entry.tableId) usage.set(entry.tableId, entry.count);
      tables.sort((a, b) => Number(b.id === row.tableId) - Number(a.id === row.tableId) || (usage.get(a.id) ?? 0) - (usage.get(b.id) ?? 0) || a.name.localeCompare(b.name));
      candidates = tables;
      if (!candidates.length) throw noTable();
    }
    await store.remove("reservations", {
      eventId: ctx.event.id,
      meetingId: row.id,
    });
    // The unique resource/slot index decides; each claim is all-or-nothing and never aborts the transaction.
    const claim = (resourceKey: string) => store.claimResource(ctx.event.id, row.id, resourceKey, quanta);
    if (!pending)
      for (const key of participantKeys)
        if (!(await claim(key))) throw participantBusy();
    let tableId: string | null = null;
    for (const table of candidates) {
      if (await claim(networkingInventoryResource(table, [requester, recipient])!)) {
        tableId = table.id;
        break;
      }
    }
    if (candidates.length && !tableId) throw noTable();
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
    // Accepting claims the proposed slot; rescheduling a pending request moves its table hold.
    const plan = async (fresh: () => Promise<NetworkingConfig | null>) => {
      if (input.action !== "ACCEPT" && input.action !== "RESCHEDULE") return [];
      const row = await networkingStore().one("meetings", { eventId: ctx.event.id, id });
      if (!row) return [];
      const config = (await fresh()) ?? ctx.config;
      if (input.action === "ACCEPT") return slotInterval(row.proposedStartsAt ?? row.startsAt, config);
      return row.status === "PENDING" ? slotInterval(input.startsAt, config) : [];
    };
    return this.allocation(ctx.event.id, plan, async (store, db) => {
      ctx = await this.networking.currentParticipant(ctx, store);
      if (input.action !== "CANCEL") this.requireEnabled(ctx);
      const row = await this.meeting(ctx, id, store);
      if (["RESCHEDULE", "ACCEPT"].includes(input.action) && (row.requesterCheckedInAt || row.recipientCheckedInAt))
        throw new ConflictException({ code: ErrorCodes.NETWORKING_MEETING_CHECKED_IN, message: "A checked-in meeting cannot be rescheduled" });
      if (!NETWORKING_OPEN_MEETING_STATUSES.includes(row.status))
        throw networkingLocked("This meeting can no longer be changed");
      await this.networking.target(
        ctx,
        row.requesterId === ctx.profile.id ? row.recipientId : row.requesterId,
        store,
      );
      if (row.status === "PENDING" && row.expiresAt <= new Date())
        throw networkingLocked("This proposal has expired");
      const proposalEnd = row.proposedStartsAt
        ? networkingSlotEnd(row.proposedStartsAt, ctx.config)
        : row.endsAt;
      if (proposalEnd <= new Date())
        throw networkingLocked("This meeting has already ended");
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
          ? await this.reserve(ctx, row, dates.startsAt, dates.endsAt, store, { hold: true })
          : {};
        update = {
          ...update,
          ...hold,
          ...(row.status === "PENDING" ? dates : {}),
          proposedStartsAt: dates.startsAt,
          proposalBy: ctx.profile.id,
          expiresAt: networkingProposalExpiry(dates.startsAt, ctx.config),
          ...(input.message?.trim() ? { message: input.message } : {}),
        };
      } else {
        const proposer = row.proposalBy ?? row.requesterId;
        if (proposer === ctx.profile.id)
          throw new ForbiddenException({ code: ErrorCodes.NETWORKING_ACTION_NOT_ALLOWED, message: "Only the other participant can respond to this proposal" });
        if (!row.proposedStartsAt && row.status !== "PENDING")
          throw networkingLocked("No proposal is awaiting a response");
        if (row.expiresAt <= new Date())
          throw networkingLocked("This proposal has expired");
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
      return this.hydrateForViewer(saved, ctx, store);
    });
  }
  /** `counterpart: false` for block/withdrawal/moderation cancellations, which never name the other side (K5). */
  async notify(
    ctx: Pick<NetworkingContext, "event">,
    row: NetworkingRow<"meetings">,
    type: keyof typeof actions,
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
          code: ErrorCodes.NETWORKING_BADGE_WRONG_PARTICIPANT,
          message: "Scan your meeting partner’s badge",
        });
      await this.networking.target(ctx, other, store);
      if (row.status !== "CONFIRMED" && row.status !== "COMPLETED")
        throw new ConflictException({
          code: ErrorCodes.NETWORKING_MEETING_CHECKIN_UNCONFIRMED,
          message: "Only confirmed meetings support check-in",
        });
      if (
        Date.now() < row.startsAt.getTime() - 30 * 60_000 ||
        Date.now() > row.endsAt.getTime() + 12 * 3_600_000
      )
        throw new BadRequestException({
          code: ErrorCodes.NETWORKING_MEETING_CHECKIN_UNAVAILABLE,
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
      return this.hydrateForViewer(saved, ctx, store);
    });
  }
  async profileAvailability(ctx: NetworkingContext, id: string) {
    this.requireEnabled(ctx);
    return {
      slots: await this.participantSlots(ctx, id),
      availableSlots: futureNetworkingSlots(ctx.config, ctx.event),
    };
  }
}
