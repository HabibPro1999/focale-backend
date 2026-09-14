import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  NetworkingSpaceSchema,
  type NetworkingSpaceInput,
  type NetworkingTableInput,
} from "@app/contracts";
import {
  networkingStore,
  networkingTables,
  networkingTransaction,
  type NetworkingRow,
  type NetworkingStore,
} from "@app/db";

const upcoming = (meeting: NetworkingRow<"meetings">) =>
  ["PENDING", "CONFIRMED", "PENDING_ALLOCATION"].includes(meeting.status) &&
  meeting.endsAt > new Date();
const location = (space: NetworkingRow<"spaces">) =>
  [space.name, space.location].filter(Boolean).join(" · ");

/** Inventory changes use the same event transaction lock as meeting allocation. */
@Injectable()
export class NetworkingInventoryService {
  async spaces(eventId: string) {
    const store = networkingStore();
    const [spaces, tables] = await Promise.all([
      store.all("spaces", { eventId }),
      store.all("tables", { eventId }),
    ]);
    const items = spaces
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((space) => ({
        ...space,
        allocatedCount: tables.filter((table) => table.spaceId === space.id)
          .length,
      }));
    return { items, total: items.length };
  }

  async saveSpace(
    eventId: string,
    input: Partial<NetworkingSpaceInput>,
    actorId: string,
    id?: string,
  ) {
    return networkingTransaction(eventId, async (store, db) => {
      const existing = id ? await store.one("spaces", { eventId, id }) : null;
      if (id && !existing) throw new NotFoundException("Space not found");
      const parsed = NetworkingSpaceSchema.safeParse({
        ...(existing
          ? {
              name: existing.name,
              kind: existing.kind,
              capacity: existing.capacity,
              location: existing.location,
              active: existing.active,
            }
          : {}),
        ...input,
      });
      if (!parsed.success)
        throw new BadRequestException(parsed.error.flatten());
      const config = parsed.data;
      if (
        (await store.all("spaces", { eventId })).some(
          (space) => space.id !== id && space.name === config.name,
        )
      )
        throw new ConflictException("A space with this name already exists");
      const tables = id
        ? await store.all("tables", { eventId, spaceId: id })
        : [];
      if (tables.length && existing?.kind !== config.kind)
        throw new ConflictException("A populated space cannot change type");
      const meetings = await store.all("meetings", { eventId });
      const tableIds = new Set(tables.map((table) => table.id));
      if (
        !config.active &&
        meetings.some(
          (meeting) =>
            meeting.tableId &&
            tableIds.has(meeting.tableId) &&
            upcoming(meeting),
        )
      )
        throw new ConflictException(
          "Reassign upcoming meetings before deactivating this space",
        );
      if (config.capacity < tables.length) {
        if (config.kind === "STAND")
          throw new ConflictException(
            "Remove exhibitors before reducing space capacity",
          );
        const removable = tables
          .filter(
            (table) =>
              !meetings.some((meeting) => meeting.tableId === table.id),
          )
          .sort(
            (a, b) =>
              b.createdAt.getTime() - a.createdAt.getTime() ||
              b.name.localeCompare(a.name, undefined, { numeric: true }),
          );
        const count = tables.length - config.capacity;
        if (removable.length < count)
          throw new ConflictException(
            "Space capacity cannot remove tables with meeting history",
          );
        for (const table of removable.slice(0, count))
          await store.remove("tables", { eventId, id: table.id });
      }
      const space = existing
        ? (await store.update("spaces", { eventId, id }, config))[0]
        : await store.insert("spaces", { eventId, ...config });
      const retained = await store.all("tables", {
        eventId,
        spaceId: space.id,
      });
      if (space.kind === "TABLE") {
        const names = new Set(retained.map((table) => table.name));
        const additions: Array<typeof networkingTables.$inferInsert> = [];
        for (
          let count = retained.length, number = 1;
          count < space.capacity;
          number++
        ) {
          const name = `Table ${number}`;
          if (names.has(name)) continue;
          additions.push({
            eventId,
            spaceId: space.id,
            name,
            kind: "TABLE",
            capacity: 2,
            location: location(space),
          });
          names.add(name);
          count++;
        }
        if (additions.length)
          await db.insert(networkingTables).values(additions);
      }
      // Keep the legacy location field consistent for exports and queued email renderers.
      await store.update(
        "tables",
        { eventId, spaceId: space.id },
        { location: location(space) },
      );
      await store.insert("audit", {
        eventId,
        actorId,
        action: existing ? "SPACE_UPDATED" : "SPACE_CREATED",
        targetId: space.id,
        data: { fields: Object.keys(input) },
      });
      return space;
    });
  }

  async removeSpace(eventId: string, id: string, actorId: string) {
    return networkingTransaction(eventId, async (store) => {
      if (!(await store.one("spaces", { eventId, id })))
        throw new NotFoundException("Space not found");
      const tables = await store.all("tables", { eventId, spaceId: id });
      const ids = new Set(tables.map((table) => table.id));
      if (
        (await store.all("meetings", { eventId })).some(
          (meeting) => meeting.tableId && ids.has(meeting.tableId),
        )
      )
        throw new ConflictException(
          "This space has meeting history; deactivate it instead",
        );
      for (const table of tables)
        await this.removeTableInTransaction(store, eventId, table.id);
      await store.remove("spaces", { eventId, id });
      await store.insert("audit", {
        eventId,
        actorId,
        action: "SPACE_REMOVED",
        targetId: id,
      });
      return { deleted: true };
    });
  }

  async tables(eventId: string) {
    const store = networkingStore();
    const [tables, spaces, profiles] = await Promise.all([
      store.all("tables", { eventId }),
      store.all("spaces", { eventId }),
      store.all("profiles", { eventId }),
    ]);
    const byId = new Map(spaces.map((space) => [space.id, space]));
    const items = tables
      .map((table) => {
        const space = table.spaceId ? byId.get(table.spaceId) : null;
        return {
          ...table,
          space: space ?? null,
          representativeIds: profiles
            .filter(
              (profile) =>
                profile.standTableId === table.id ||
                profile.id === table.ownerProfileId,
            )
            .map((profile) => profile.id),
          representatives: profiles
            .filter(
              (profile) =>
                profile.standTableId === table.id ||
                profile.id === table.ownerProfileId,
            )
            .map(({ id, firstName, lastName, company }) => ({
              id,
              firstName,
              lastName,
              company,
            })),
        };
      })
      .sort((a, b) =>
        `${a.space?.name} ${a.name}`.localeCompare(
          `${b.space?.name} ${b.name}`,
          undefined,
          { numeric: true },
        ),
      );
    return { items, total: items.length };
  }

  async assertRepresentativeMove(
    store: NetworkingStore,
    eventId: string,
    profile: NetworkingRow<"profiles">,
    standTableId: string | null,
  ) {
    if (profile.standTableId === standTableId) return;
    if (standTableId) {
      const stand = await store.one("tables", {
        eventId,
        id: standTableId,
        kind: "STAND",
      });
      if (!stand)
        throw new BadRequestException("Exhibitor must belong to this event");
    }
    if (
      (await store.all("meetings", { eventId })).some(
        (meeting) =>
          upcoming(meeting) &&
          (meeting.requesterId === profile.id ||
            meeting.recipientId === profile.id),
      )
    )
      throw new ConflictException(
        "Cancel or finish upcoming meetings before changing this representative's exhibitor",
      );
  }

  async saveTable(
    eventId: string,
    input: Partial<NetworkingTableInput>,
    actorId: string,
    id?: string,
  ) {
    return networkingTransaction(eventId, async (store) => {
      const existing = id ? await store.one("tables", { eventId, id }) : null;
      if (id && !existing)
        throw new NotFoundException("Table or exhibitor not found");
      const spaceId = input.spaceId ?? existing?.spaceId;
      const space = spaceId
        ? await store.one("spaces", { eventId, id: spaceId })
        : null;
      if (!space) throw new BadRequestException("Choose a space in this event");
      const kind = input.kind ?? existing?.kind ?? space.kind;
      if (kind !== space.kind)
        throw new BadRequestException(
          "Table/exhibitor type must match its space",
        );
      if (input.capacity !== undefined && input.capacity !== 2)
        throw new BadRequestException("Meetings always have two people");
      const siblings = await store.all("tables", {
        eventId,
        spaceId: space.id,
      });
      if (existing?.spaceId !== space.id && siblings.length >= space.capacity)
        throw new ConflictException(
          "This space has reached its table/exhibitor capacity",
        );
      const name = (input.name ?? existing?.name ?? "").trim();
      if (!name) throw new BadRequestException("Name is required");
      if (siblings.some((table) => table.id !== id && table.name === name))
        throw new ConflictException("Name already used in this space");
      const profiles = await store.all("profiles", { eventId });
      const currentIds = profiles
        .filter(
          (profile) =>
            profile.standTableId === id ||
            (existing?.ownerProfileId &&
              profile.id === existing.ownerProfileId),
        )
        .map((profile) => profile.id);
      const representatives = [
        ...new Set(
          input.representativeIds ??
            (input.ownerProfileId !== undefined
              ? input.ownerProfileId
                ? [input.ownerProfileId]
                : []
              : currentIds),
        ),
      ];
      if (kind === "TABLE" && representatives.length)
        throw new BadRequestException("Only exhibitors have representatives");
      if (kind === "STAND" && !representatives.length)
        throw new BadRequestException(
          "Select at least one exhibitor representative",
        );
      for (const representative of representatives) {
        const profile = profiles.find(
          (profile) => profile.id === representative,
        );
        if (!profile)
          throw new BadRequestException(
            "Representatives must belong to this event",
          );
        if (profile.standTableId && profile.standTableId !== id)
          throw new ConflictException(
            "A representative is already assigned to another exhibitor",
          );
      }
      const meetings = id
        ? await store.all("meetings", { eventId, tableId: id })
        : [];
      if (
        meetings.some(upcoming) &&
        (input.active === false ||
          existing?.spaceId !== space.id ||
          existing?.kind !== kind)
      )
        throw new ConflictException(
          "Reassign upcoming meetings before changing this table or exhibitor",
        );
      // Removing a representative must not invalidate any outstanding proposal or booking.
      for (const profile of profiles.filter(
        (profile) =>
          currentIds.includes(profile.id) &&
          !representatives.includes(profile.id),
      ))
        await this.assertRepresentativeMove(store, eventId, profile, null);
      const data = {
        spaceId: space.id,
        name,
        kind,
        capacity: 2,
        location: location(space),
        active: input.active ?? existing?.active ?? true,
        ownerProfileId: representatives[0] ?? null,
      };
      const table = existing
        ? (await store.update("tables", { eventId, id }, data))[0]
        : await store.insert("tables", { eventId, ...data });
      for (const profile of profiles.filter(
        (profile) =>
          currentIds.includes(profile.id) ||
          representatives.includes(profile.id),
      )) {
        const standTableId = representatives.includes(profile.id)
          ? table.id
          : null;
        if (profile.standTableId === standTableId) continue;
        await this.assertRepresentativeMove(
          store,
          eventId,
          profile,
          standTableId,
        );
        await store.update(
          "profiles",
          { eventId, id: profile.id },
          { standTableId, overrides: { ...profile.overrides, standTableId } },
        );
      }
      await store.insert("audit", {
        eventId,
        actorId,
        action: existing ? "TABLE_UPDATED" : "TABLE_CREATED",
        targetId: table.id,
        data: { fields: Object.keys(input) },
      });
      return { ...table, representativeIds: representatives, space };
    });
  }

  private async removeTableInTransaction(
    store: NetworkingStore,
    eventId: string,
    id: string,
  ) {
    if ((await store.all("meetings", { eventId, tableId: id })).length)
      throw new ConflictException(
        "This table/exhibitor has meeting history; deactivate it instead",
      );
    const profiles = await store.all("profiles", { eventId, standTableId: id });
    for (const profile of profiles) {
      await this.assertRepresentativeMove(store, eventId, profile, null);
      await store.update(
        "profiles",
        { eventId, id: profile.id },
        {
          standTableId: null,
          overrides: { ...profile.overrides, standTableId: null },
        },
      );
    }
    await store.remove("tables", { eventId, id });
  }

  async removeTable(eventId: string, id: string, actorId: string) {
    return networkingTransaction(eventId, async (store) => {
      if (!(await store.one("tables", { eventId, id })))
        throw new NotFoundException("Table/exhibitor not found");
      await this.removeTableInTransaction(store, eventId, id);
      await store.insert("audit", {
        eventId,
        actorId,
        action: "TABLE_REMOVED",
        targetId: id,
      });
      return { deleted: true };
    });
  }
}
