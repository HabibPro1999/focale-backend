import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import {
  clients,
  forms,
  deleteFormById,
  getDb,
  networkingStore,
  deleteClientRow,
  type NetworkingRow,
} from "@app/db";
import { NetworkingConfigSchema } from "@app/contracts";
import {
  NetworkingService,
  type NetworkingContext,
} from "./networking.service";
import { NetworkingMeetingsService } from "./networking.meetings.service";
import { NetworkingSocialService } from "./networking.social.service";
import { NetworkingInventoryService } from "./networking.inventory.service";
import { networkingHash } from "./networking.security";

const enabled =
  process.env.ALLOW_DB_TESTS === "1" && !!process.env.TEST_DATABASE_URL;
const inventory = new NetworkingInventoryService();
const service = new NetworkingService();
const meetings = new NetworkingMeetingsService(service);
const social = new NetworkingSocialService(service);
const clientIds: string[] = [];
const formIds = new Map<string, string>();
let event: NetworkingRow<"events">;
let people: NetworkingContext[];
const slot = "2031-04-05T10:00:00.000Z";
const later = "2031-04-05T11:00:00.000Z";
const config = NetworkingConfigSchema.parse({
  enabled: true,
  approvalMode: "AUTOMATIC",
  timezone: "UTC",
  openingHours: [{ date: "2031-04-05", start: "09:00", end: "17:00" }],
});
async function request(a: number, b: number, startsAt = slot) {
  await social.interest(people[a], people[b].profile.id, "LIKE");
  await social.interest(people[b], people[a].profile.id, "LIKE");
  return meetings.create(people[a], {
    profileId: people[b].profile.id,
    startsAt,
  });
}
async function exhibitor(representatives = [0, 1], capacity = 1) {
  const space = await inventory.saveSpace(
    event.id,
    { name: "Exhibition hall", kind: "STAND", capacity },
    "qa",
  );
  const stand = await inventory.saveTable(
    event.id,
    {
      spaceId: space.id,
      kind: "STAND",
      name: "Organization A",
      representativeIds: representatives.map(
        (index) => people[index].profile.id,
      ),
    },
    "qa",
  );
  return { space, stand };
}

describe.runIf(enabled)(
  "networking spaces and independent exhibitor representatives",
  () => {
    beforeAll(() => {
      const url = new URL(process.env.TEST_DATABASE_URL!);
      if (
        !["localhost", "127.0.0.1"].includes(url.hostname) ||
        !url.pathname.startsWith("/focale_networking_test_spaces_")
      )
        throw new Error(
          "Inventory tests require their dedicated local spaces test database",
        );
      process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
      process.env.NETWORKING_TOKEN_SECRET =
        "spaces-test-secret-at-least-32-characters";
    });
    beforeEach(async () => {
      const store = networkingStore();
      const clientId = randomUUID();
      clientIds.push(clientId);
      await getDb()
        .insert(clients)
        .values({
          id: clientId,
          name: "Spaces fixture",
          enabledModules: ["networking", "registrations", "emails"],
        });
      event = await store.insert("events", {
        clientId,
        name: "Spaces",
        slug: randomUUID(),
        status: "OPEN",
        startDate: new Date("2031-04-05"),
        endDate: new Date("2031-04-06"),
      });
      await store.insert("configs", { eventId: event.id, config });
      const formId = randomUUID();
      formIds.set(event.id, formId);
      await getDb()
        .insert(forms)
        .values({
          id: formId,
          eventId: event.id,
          name: "Registration",
          schema: { steps: [] },
        });
      people = [];
      for (let index = 0; index < 6; index++) {
        const registration = await store.insert("registrations", {
          formId,
          eventId: event.id,
          email: `${randomUUID()}@example.invalid`,
          paymentStatus: "PAID",
          networkingOptIn: true,
          totalAmount: 0,
          priceBreakdown: {},
          formData: {},
        });
        const profile = await store.insert("profiles", {
          eventId: event.id,
          registrationId: registration.id,
          email: registration.email,
          firstName: `Person ${index}`,
          lastName: "Test",
          company: "Organization A",
          jobTitle: "Representative",
          sector: "Technology",
          status: "ACTIVE",
          visible: true,
          consent: true,
          availabilitySet: true,
        });
        for (const startsAt of [slot, later])
          await store.insert("availability", {
            eventId: event.id,
            profileId: profile.id,
            startsAt: new Date(startsAt),
          });
        const session = await store.insert("sessions", {
          eventId: event.id,
          profileId: profile.id,
          tokenHash: networkingHash(randomBytes(48).toString("base64url")),
          expiresAt: event.endDate,
        });
        people.push({ event, config, profile, session });
      }
    });
    afterAll(async () => {
      const store = networkingStore();
      for (const clientId of clientIds) {
        for (const row of await store.all("events", { clientId })) {
          await store.remove("meetings", { eventId: row.id });
          await store.remove("tables", { eventId: row.id });
          await store.remove("spaces", { eventId: row.id });
          await store.remove("registrations", { eventId: row.id });
          if (formIds.has(row.id)) await deleteFormById(formIds.get(row.id)!);
          await store.remove("events", { id: row.id });
        }
        await deleteClientRow(clientId);
      }
    });

    it("creates exactly two-person tables and permits simultaneous meetings in one space", async () => {
      const space = await inventory.saveSpace(
        event.id,
        { name: "Room A", kind: "TABLE", capacity: 2 },
        "qa",
      );
      const tables = (await inventory.tables(event.id)).items;
      expect(tables).toHaveLength(2);
      expect(
        tables.every(
          (table) => table.spaceId === space.id && table.capacity === 2,
        ),
      ).toBe(true);
      const first = await request(0, 1),
        second = await request(2, 3);
      const accepted = await Promise.all([
        meetings.respond(people[1], first.id, { action: "ACCEPT" }),
        meetings.respond(people[3], second.id, { action: "ACCEPT" }),
      ]);
      expect(accepted.map((meeting) => meeting.status)).toEqual([
        "CONFIRMED",
        "CONFIRMED",
      ]);
      expect(new Set(accepted.map((meeting) => meeting.tableId)).size).toBe(2);
      await expect(
        inventory.saveSpace(event.id, { capacity: 1 }, "qa", space.id),
      ).rejects.toThrow(/history/);
      await expect(
        inventory.saveSpace(event.id, { active: false }, "qa", space.id),
      ).rejects.toThrow(/upcoming/);
    });

    it("books two representatives in one exhibitor slot and keeps a third independently available", async () => {
      const { space, stand } = await exhibitor([0, 1, 2]);
      const first = await request(3, 0),
        second = await request(4, 1);
      const accepted = await Promise.all([
        meetings.respond(people[0], first.id, { action: "ACCEPT" }),
        meetings.respond(people[1], second.id, { action: "ACCEPT" }),
      ]);
      expect(
        accepted.every(
          (meeting) =>
            meeting.tableId === stand.id && meeting.status === "CONFIRMED",
        ),
      ).toBe(true);
      expect((await inventory.spaces(event.id)).items[0]).toMatchObject({
        id: space.id,
        capacity: 1,
        allocatedCount: 1,
      });
      expect(
        await meetings.participantSlots(people[5], people[0].profile.id),
      ).not.toContain(slot);
      expect(
        await meetings.participantSlots(people[5], people[2].profile.id),
      ).toContain(slot);
      const reservations = await networkingStore().all("reservations", {
        eventId: event.id,
      });
      expect(
        reservations.some((row) => row.resourceKey === `table:${stand.id}`),
      ).toBe(false);
      for (const index of [0, 1])
        expect(
          reservations.some(
            (row) =>
              row.resourceKey ===
              `stand:${stand.id}:profile:${people[index].profile.id}`,
          ),
        ).toBe(true);
    });

    it("never holds one representative twice under concurrent requests", async () => {
      await exhibitor();
      const results = await Promise.allSettled([request(2, 0), request(3, 0)]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
      const winner = results.find(result => result.status === "fulfilled")! as PromiseFulfilledResult<Awaited<ReturnType<typeof request>>>;
      expect((await meetings.respond(people[0], winner.value.id, { action: "ACCEPT" })).status).toBe("CONFIRMED");
    });

    it("does not allocate an exhibitor to two visitors or two of its representatives", async () => {
      await exhibitor();
      await expect(request(2, 3)).rejects.toThrow(/available/);
      await expect(request(0, 1)).rejects.toThrow(/available/);
    });

    it("enforces exhibitor-space capacity and preserves memberships on failure", async () => {
      const { space } = await exhibitor();
      await expect(
        inventory.saveTable(
          event.id,
          {
            spaceId: space.id,
            kind: "STAND",
            name: "Overflow",
            representativeIds: [people[2].profile.id],
          },
          "qa",
        ),
      ).rejects.toThrow(/capacity/);
      expect(
        (
          await networkingStore().one("profiles", {
            id: people[2].profile.id,
            eventId: event.id,
          })
        )?.standTableId,
      ).toBeNull();
      await expect(
        inventory.saveTable(
          event.id,
          { spaceId: space.id, name: "Wrong type", kind: "TABLE" },
          "qa",
        ),
      ).rejects.toThrow(/type/);
      await inventory.saveSpace(event.id, { capacity: 2 }, "qa", space.id);
      await expect(
        inventory.saveTable(
          event.id,
          {
            spaceId: space.id,
            kind: "STAND",
            name: "Other organization",
            representativeIds: [people[0].profile.id],
          },
          "qa",
        ),
      ).rejects.toThrow(/another exhibitor/);
    });

    it("rejects a foreign space or representative and rolls back the entire edit", async () => {
      const { stand } = await exhibitor();
      await expect(
        inventory.saveTable(
          event.id,
          {
            spaceId: randomUUID(),
            name: "Foreign",
            kind: "STAND",
            representativeIds: [people[2].profile.id],
          },
          "qa",
        ),
      ).rejects.toThrow(/space/);
      await expect(
        inventory.saveTable(
          event.id,
          { representativeIds: [randomUUID()], name: "Changed" },
          "qa",
          stand.id,
        ),
      ).rejects.toThrow(/event/);
      expect((await inventory.tables(event.id)).items[0].name).toBe(
        "Organization A",
      );
      expect(
        (await inventory.tables(event.id)).items[0].representativeIds,
      ).toHaveLength(2);
    });

    it("preserves booked representatives on edits and allows adding a free representative", async () => {
      const { stand } = await exhibitor();
      const meeting = await request(2, 0);
      await meetings.respond(people[0], meeting.id, { action: "ACCEPT" });
      await expect(
        inventory.saveTable(
          event.id,
          { representativeIds: [people[1].profile.id] },
          "qa",
          stand.id,
        ),
      ).rejects.toThrow(/upcoming/);
      const updated = await inventory.saveTable(
        event.id,
        {
          representativeIds: [0, 1, 3].map((index) => people[index].profile.id),
        },
        "qa",
        stand.id,
      );
      expect(updated.representativeIds).toHaveLength(3);
      await expect(
        inventory.removeSpace(event.id, stand.spaceId!, "qa"),
      ).rejects.toThrow(/history/);
    });

    it("cancels only the selected representative's reservation and preserves the other booking", async () => {
      await exhibitor();
      const first = await request(2, 0),
        second = await request(3, 1);
      await meetings.respond(people[0], first.id, { action: "ACCEPT" });
      await meetings.respond(people[1], second.id, { action: "ACCEPT" });
      await meetings.respond(people[2], first.id, { action: "CANCEL" });
      expect(
        await meetings.participantSlots(people[4], people[0].profile.id),
      ).toContain(slot);
      expect(
        await meetings.participantSlots(people[4], people[1].profile.id),
      ).not.toContain(slot);
    });

    it("resizes an unused table space without duplicating table numbers", async () => {
      const space = await inventory.saveSpace(
        event.id,
        { name: "Room", kind: "TABLE", capacity: 3 },
        "qa",
      );
      await inventory.saveSpace(event.id, { capacity: 1 }, "qa", space.id);
      await inventory.saveSpace(
        event.id,
        { capacity: 4, name: "New room" },
        "qa",
        space.id,
      );
      const tables = (await inventory.tables(event.id)).items;
      expect(tables).toHaveLength(4);
      expect(new Set(tables.map((table) => table.name)).size).toBe(4);
      expect(tables.every((table) => table.location === "New room")).toBe(true);
      await inventory.removeSpace(event.id, space.id, "qa");
      expect((await inventory.tables(event.id)).total).toBe(0);
    });

    it("filters the public exhibitor roster by consent, visibility and symmetric blocks", async () => {
      await exhibitor([0, 1, 2]);
      await networkingStore().update(
        "profiles",
        { eventId: event.id, id: people[1].profile.id },
        { visible: false },
      );
      await social.block(people[2], people[5].profile.id);
      const roster = await service.representatives(
        people[5],
        people[0].profile.id,
      );
      expect(roster.items.map((profile) => profile.id)).toEqual([
        people[0].profile.id,
      ]);
      expect(roster.items[0]).not.toHaveProperty("email");
      expect(roster.exhibitor?.name).toBe("Organization A");
    });

    it("keeps reservations unchanged when a reschedule fails", async () => {
      await exhibitor();
      const first = await request(2, 0);
      await meetings.respond(people[0], first.id, { action: "ACCEPT" });
      await meetings.respond(people[2], first.id, {
        action: "RESCHEDULE",
        startsAt: later,
      });
      const other = await request(3, 0, later);
      await meetings.respond(people[0], other.id, { action: "ACCEPT" });
      const before = await networkingStore().all("reservations", {
        eventId: event.id,
        meetingId: first.id,
      });
      await expect(
        meetings.respond(people[0], first.id, { action: "ACCEPT" }),
      ).rejects.toThrow(/meeting|unavailable/);
      const after = await networkingStore().all("reservations", {
        eventId: event.id,
        meetingId: first.id,
      });
      expect(after.map((row) => row.id).sort()).toEqual(
        before.map((row) => row.id).sort(),
      );
    });
  },
);
