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
  getDb,
  createNetworkingNotification,
  expireNetworkingProposals,
  getNetworkingConfig,
  listNetworkingParticipantMeetings,
  countNetworkingParticipantMeetings,
  networkingAllocationTransaction,
  NetworkingAllocationLockError,
  NetworkingBusyError,
  networkingMeetingIs,
  networkingMeetingNotice,
  networkingPendingHoldKey,
  networkingStore,
  networkingTransaction,
  transitionNetworkingMeetings,
  type NetworkingInterval,
  type NetworkingMeetingCancelReason,
  type NetworkingRow,
  type NetworkingStore,
  type DbExecutor,
} from "@app/db";
import type { NetworkingConfig } from "@app/contracts";
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
type MeetingRow = NetworkingRow<"meetings">;
/** Re-plans after the meeting moved between the lock plan's read and the lock. */
const ALLOCATION_PLAN_ATTEMPTS = 3;
/** The slot a meeting would occupy from `start`, or none when `start` is not a valid instant. */
function slotInterval(start: Date | string | null | undefined, config: Pick<NetworkingConfig, "slotDurationMinutes">): NetworkingInterval[] {
  const startsAt = start ? new Date(start) : null;
  if (!startsAt || !Number.isFinite(startsAt.getTime())) return [];
  return [{ startsAt, endsAt: new Date(startsAt.getTime() + config.slotDurationMinutes * 60_000) }];
}
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
    store = networkingStore(getDb()),
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
          await networkingStore(getDb()).all("availability", {
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
  /** The meetings' tables, each with its space, by table id (one statement). */
  private async places(eventId: string, rows: MeetingRow[], store: NetworkingStore) {
    const places = await store.meetingPlaces(eventId, rows);
    return new Map(places.map(({ table, space }) => [table.id, { ...table, space: space ?? null }]));
  }
  /**
   * The participant's view of their meetings (4.9 `hydrateForViewer`): each
   * participant as a public profile when the viewer may see them (`profile`
   * mode, one statement for the whole list), else null, and the table with
   * its space (one more). The viewer must still be eligible, as for target().
   */
  async hydrateForViewer(ctx: NetworkingContext, rows: MeetingRow[], store = networkingStore(getDb())) {
    if (!rows.length) return [];
    const [people, tables] = await Promise.all([
      this.networking.visibleCounterparts(ctx, rows.flatMap((row) => [row.requesterId, row.recipientId]), store),
      this.places(ctx.event.id, rows, store),
    ]);
    const view = (id: string) => {
      const profile = id === ctx.profile.id ? people.viewer : people.visible.get(id);
      return profile ? networkingPublicProfile(profile) : null;
    };
    return rows.map((row) => ({
      ...row,
      requester: view(row.requesterId),
      recipient: view(row.recipientId),
      table: row.tableId ? tables.get(row.tableId) ?? null : null,
    }));
  }
  /** One of the participant's meetings, hydrated like a list item (K2). */
  async hydrateOne(ctx: NetworkingContext, row: MeetingRow, store = networkingStore(getDb())) {
    const [item] = await this.hydrateForViewer(ctx, [row], store);
    return item!;
  }
  /** The organizer's view of meetings: both participants' rows and the table with its space (two statements). */
  async hydrateAdmin(eventId: string, rows: MeetingRow[], store = networkingStore(getDb())) {
    if (!rows.length) return [];
    const [profiles, tables] = await Promise.all([
      store.profilesByIds(eventId, rows.flatMap((row) => [row.requesterId, row.recipientId])),
      this.places(eventId, rows, store),
    ]);
    const byId = new Map(profiles.map((profile) => [profile.id, profile]));
    return rows.map((row) => ({
      ...row,
      requester: byId.get(row.requesterId) ?? null,
      recipient: byId.get(row.recipientId) ?? null,
      table: row.tableId ? tables.get(row.tableId) ?? null : null,
    }));
  }
  async hydrateCalendar(eventId: string, rows: MeetingRow[]) {
    if (!rows.length) return [];
    const store = networkingStore(getDb());
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
    return rows.map(row => {
      const table = row.tableId ? tables.get(row.tableId) ?? null : null;
      return {
        ...row,
        requester: profiles.get(row.requesterId) ?? null,
        recipient: profiles.get(row.recipientId) ?? null,
        table: table ? { ...table, space: table.spaceId ? spaces.get(table.spaceId) ?? null : null } : null,
      };
    });
  }
  /** Idempotent single statements: read paths need no transaction. */
  async expire(eventId: string) {
    await expireNetworkingProposals(eventId, getDb());
  }
  async list(ctx: NetworkingContext, query: NetworkingParticipantListQuery = {}) {
    const page = participantPagination("meetings", ctx, query);
    if (!page.after) await this.expire(ctx.event.id);
    const rows = await listNetworkingParticipantMeetings(ctx.event.id, ctx.profile.id, page);
    const visibleRows = rows.slice(0, page.limit);
    const last = visibleRows.at(-1);
    return {
      items: await this.hydrateForViewer(ctx, visibleRows),
      nextCursor: rows.length > page.limit && last ? page.cursor(last.startsAt, last.id) : null,
      ...(page.after ? {} : { total: await countNetworkingParticipantMeetings(ctx.event.id, ctx.profile.id) }),
    };
  }
  /** Internal, unpaginated: exports must never be truncated. Not exposed over HTTP. */
  async allMeetings(ctx: NetworkingContext) {
    await this.expire(ctx.event.id);
    return this.hydrateForViewer(ctx, await listNetworkingParticipantMeetings(ctx.event.id, ctx.profile.id));
  }
  /** One own meeting, same hydrated shape as a GET meetings item (K2). */
  async get(ctx: NetworkingContext, id: string) {
    await this.expire(ctx.event.id);
    const store = networkingStore(getDb());
    return this.hydrateOne(ctx, await this.meeting(ctx, id, store), store);
  }
  async meeting(ctx: NetworkingContext, id: string, store = networkingStore(getDb())) {
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
          throw new ForbiddenException({ code: "NETWORKING_CONNECTION_REQUIRED", message: "A mutual connection is required before requesting a meeting" });
        await this.availableAt(ctx, ctx.profile.id, dates.startsAt, store);
        await this.availableAt(ctx, input.profileId, dates.startsAt, store);
        const same = (
          await store.allocationMeetings(ctx.event.id, dates.startsAt, dates.endsAt)
        ).find(
          (m) =>
            networkingMeetingIs(m.status, "open") &&
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
        return this.hydrateOne(ctx, row, store);
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
    const now = new Date();
    await transitionNetworkingMeetings(store.executor, "EXPIRE", ctx.event.id,
      meetings.filter((meeting) => meeting.status === "PENDING" && meeting.expiresAt <= now).map((meeting) => meeting.id));
    const reservations = (
      await store.allocationReservations(ctx.event.id, quanta[0], endsAt)
    ).filter((v) => v.meetingId !== row.id);
    const occupied = new Set(reservations.map(reservation => `${reservation.resourceKey}:${reservation.startsAt.getTime()}`));
    const taken = (key: string) => quanta.some(quantum => occupied.has(`${key}:${quantum.getTime()}`));
    const participantKeys = [
      `profile:${row.requesterId}`,
      `profile:${row.recipientId}`,
    ];
    // A pending request holds its requester's slot, not the participants: one pending request per requester per slot.
    const holdKey = networkingPendingHoldKey(row.requesterId);
    const participantBusy = () =>
      new ConflictException({ code: "NETWORKING_SLOT_CONFLICT", message: "One of the participants already has a meeting in this slot" });
    const holdBusy = () =>
      new ConflictException({ code: ErrorCodes.NETWORKING_SLOT_CONFLICT, message: "The requester already has a pending meeting request in this slot" });
    const noTable = () =>
      new ConflictException({ code: ErrorCodes.NETWORKING_SLOT_CONFLICT, message: "No table or exhibitor representative is available for this slot; choose another time" });
    if (participantKeys.some(taken)) throw participantBusy();
    if (pending && taken(holdKey)) throw holdBusy();
    const [requester, recipient, spaces] = await Promise.all([
      store.one("profiles", { eventId: ctx.event.id, id: row.requesterId }),
      store.one("profiles", { eventId: ctx.event.id, id: row.recipientId }),
      store.all("spaces", { eventId: ctx.event.id }),
    ]);
    if (!requester || !recipient) throw new NotFoundException({ code: ErrorCodes.NETWORKING_NOT_FOUND, message: "Participant not found" });
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
    if (pending) {
      if (!(await claim(holdKey))) throw holdBusy();
    } else
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
      const row = await networkingStore(getDb()).one("meetings", { eventId: ctx.event.id, id });
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
        throw new ConflictException({ code: "NETWORKING_MEETING_CHECKED_IN", message: "A checked-in meeting cannot be rescheduled" });
      if (!networkingMeetingIs(row.status, "open"))
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
      // CANCEL and a pending request's DECLINE are status transitions that release every reservation.
      let transition: "CANCEL" | "DECLINE" | undefined;
      if (input.action === "CANCEL") {
        transition = "CANCEL";
        update = {
          cancellationNote: input.message?.trim() ?? "",
          proposedStartsAt: null,
          proposalBy: null,
        };
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
          // Declining a counter-proposal on an accepted meeting keeps the original booking.
          if (row.status === "PENDING") transition = "DECLINE";
          update = {
            ...(transition ? {} : update),
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
      const [saved] = transition
        ? await transitionNetworkingMeetings(db, transition, ctx.event.id, [id], update)
        : await store.update("meetings", { eventId: ctx.event.id, id }, update);
      if (!saved)
        throw new ConflictException({ code: "NETWORKING_MEETING_LOCKED", message: "This meeting can no longer be changed" });
      await this.notify(
        ctx,
        saved,
        `MEETING_${input.action}`,
        [row.requesterId, row.recipientId],
        db,
        { reason: "PARTICIPANT" },
      );
      return this.hydrateOne(ctx, saved, store);
    });
  }
  /**
   * One notice per participant, built by the lifecycle module. `reason` goes on
   * cancellation notices; `confidential` notices (block, withdrawal, moderation)
   * name neither the other side nor the place (K5).
   */
  async notify(
    ctx: Pick<NetworkingContext, "event">,
    row: NetworkingRow<"meetings">,
    type: string,
    profileIds: string[],
    db: DbExecutor,
    options: { reason?: NetworkingMeetingCancelReason; confidential?: boolean } = {},
  ) {
    const store = networkingStore(db);
    const table = !options.confidential && row.tableId ? await store.one("tables", { eventId: row.eventId, id: row.tableId }) : null;
    const space = table?.spaceId ? await store.one("spaces", { eventId: row.eventId, id: table.spaceId }) : null;
    for (const profileId of profileIds) {
      const counterpart = options.confidential ? null : await store.one("profiles", {
        eventId: row.eventId,
        id: profileId === row.requesterId ? row.recipientId : row.requesterId,
      });
      await createNetworkingNotification(
        networkingMeetingNotice(row, profileId, {
          type,
          slug: ctx.event.slug,
          reason: options.confidential ? "UNAVAILABLE" : options.reason,
          confidential: options.confidential,
          ...(counterpart ? { counterpartName: `${counterpart.firstName} ${counterpart.lastName}`.trim() } : {}),
          ...(table ? { tableName: table.name } : {}),
          ...(space ? { spaceName: space.name } : {}),
        }),
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
      return this.hydrateOne(ctx, saved, store);
    });
  }
}
