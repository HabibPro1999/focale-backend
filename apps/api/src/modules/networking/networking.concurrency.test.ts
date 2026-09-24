import { beforeAll, describe, expect, it } from "vitest";
import { ConflictException } from "@nestjs/common";
import { networkingStore, type NetworkingRow } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import {
  createNetworkingWriteFixture,
  networkingDoubleBookings,
} from "../../../../../packages/db/tests/helpers/networking-write-fixture";
import { NetworkingService, type NetworkingContext } from "./networking.service";
import { NetworkingSocialService } from "./networking.social.service";
import { NetworkingMeetingsService } from "./networking.meetings.service";
import { networkingHash } from "./networking.security";

// Plan 4.1: without the event row lock, concurrent networking writes must all
// finish (retrying serialization failures), keep the unique-index invariants,
// and answer a lost race with a 4xx, never a 5xx.
const service = new NetworkingService();
const social = new NetworkingSocialService(service);
const meetings = new NetworkingMeetingsService(service);
const firstSlot = new Date("2031-04-05T09:00:00.000Z");
const secondSlot = new Date("2031-04-05T11:00:00.000Z");
const thirdSlot = new Date("2031-04-05T14:00:00.000Z");
let fixture: Awaited<ReturnType<typeof createNetworkingWriteFixture>>;
let people: NetworkingContext[];
const range = (count: number, from = 0) => Array.from({ length: count }, (_, index) => from + index);

async function settle<T>(work: Array<() => Promise<T>>) {
  return Promise.allSettled(work.map((run) => run()));
}
function failures(results: PromiseSettledResult<unknown>[]) {
  return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}
async function connect(a: number, b: number) {
  await social.interest(people[a], people[b].profile.id, "LIKE");
  await social.interest(people[b], people[a].profile.id, "LIKE");
}

describe.runIf(dbTestsEnabled())("networking writes under concurrency", () => {
  beforeAll(async () => {
    process.env.NETWORKING_TOKEN_SECRET ??= "test-networking-secret-at-least-32-characters";
    fixture = await createNetworkingWriteFixture({
      size: 24, slots: [firstSlot, secondSlot, thirdSlot], tables: 10, hash: networkingHash,
    });
    people = fixture.participants.map(({ profile, session }) => ({
      event: fixture.event, config: fixture.config, profile, session,
    }));
  }, 240_000);

  it("finishes 10 concurrent swipes by distinct participants", async () => {
    const results = await settle(range(10).map((i) => () => social.interest(people[i], people[i + 10].profile.id, "LIKE")));
    expect(failures(results)).toEqual([]);
    const likes = await networkingStore().all("interests", { eventId: fixture.event.id, action: "LIKE" });
    expect(likes).toHaveLength(10);
  });

  it("turns 10 concurrent mutual likes into one connection and one MATCH per side", async () => {
    const [a, b] = [people[20], people[21]];
    const results = await settle(range(10).map((i) => () =>
      i % 2 ? social.interest(a, b.profile.id, "LIKE") : social.interest(b, a.profile.id, "LIKE")));
    expect(failures(results)).toEqual([]);
    const [profileAId, profileBId] = [a.profile.id, b.profile.id].sort();
    expect(await networkingStore().all("connections", { eventId: fixture.event.id, profileAId, profileBId })).toHaveLength(1);
    for (const person of [a, b])
      expect(await networkingStore().all("notifications", { eventId: fixture.event.id, profileId: person.profile.id, type: "MATCH" })).toHaveLength(1);
    expect(await networkingStore().all("interests", { eventId: fixture.event.id, profileId: a.profile.id, targetId: b.profile.id })).toHaveLength(1);
  });

  it("finishes 10 concurrent messages on distinct connections", async () => {
    for (const i of range(10)) await social.interest(people[i + 10], people[i].profile.id, "LIKE");
    const connections = await Promise.all(range(10).map(async (i) => {
      const [profileAId, profileBId] = [people[i].profile.id, people[i + 10].profile.id].sort();
      return (await networkingStore().one("connections", { eventId: fixture.event.id, profileAId, profileBId }))!;
    }));
    const results = await settle(range(10).map((i) => () =>
      social.sendMessage(people[i], connections[i].id, `Hello ${i}`, `message-${i}`)));
    expect(failures(results)).toEqual([]);
    expect(await networkingStore().all("messages", { eventId: fixture.event.id })).toHaveLength(10);
  });

  it("finishes 10 concurrent sign-in code requests for distinct participants", async () => {
    const results = await settle(range(10).map((i) => () => service.requestCode(fixture.event.slug, people[i].profile.email)));
    expect(failures(results)).toEqual([]);
    const deliveries = await networkingStore().all("deliveries", { eventId: fixture.event.id, type: "OTP" });
    expect(new Set(deliveries.map((row) => row.profileId))).toEqual(new Set(range(10).map((i) => people[i].profile.id)));
  });

  it("books 10 concurrent requests onto 10 tables, then confirms them all concurrently", async () => {
    const results = await settle(range(10).map((i) => () =>
      meetings.create(people[i], { profileId: people[i + 10].profile.id, startsAt: firstSlot.toISOString() })));
    expect(failures(results)).toEqual([]);
    const booked = results.map((result) => (result as PromiseFulfilledResult<NetworkingRow<"meetings">>).value);
    expect(new Set(booked.map((row) => row.tableId)).size).toBe(10);
    const accepted = await settle(booked.map((row, i) => () => meetings.respond(people[i + 10], row.id, { action: "ACCEPT" })));
    expect(failures(accepted)).toEqual([]);
    expect(await networkingStore().all("meetings", { eventId: fixture.event.id, status: "CONFIRMED" })).toHaveLength(10);
    expect(await networkingDoubleBookings(fixture.event.id)).toEqual([]);
  });

  it("books 3 of 10 concurrent requests onto 3 tables and answers the other 7 with 409", async () => {
    for (const table of fixture.tables.slice(3))
      await networkingStore().update("tables", { eventId: fixture.event.id, id: table.id }, { active: false });
    const results = await settle(range(10).map((i) => () =>
      meetings.create(people[i], { profileId: people[i + 10].profile.id, startsAt: secondSlot.toISOString() })));
    const errors = failures(results);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(errors).toHaveLength(7);
    for (const error of errors) {
      expect(error).toBeInstanceOf(ConflictException);
      expect(error).toMatchObject({ status: 409, response: { code: "NETWORKING_SLOT_CONFLICT" } });
    }
    expect(await networkingDoubleBookings(fixture.event.id)).toEqual([]);
  });

  it("keeps one participant from being confirmed twice when both of their slot requests are accepted at once", async () => {
    for (const table of fixture.tables.slice(3))
      await networkingStore().update("tables", { eventId: fixture.event.id, id: table.id }, { active: true });
    const host = people[0];
    const requests = await Promise.all([1, 2].map(async (offset) => {
      await connect(0, 20 + offset);
      return meetings.create(people[20 + offset], { profileId: host.profile.id, startsAt: thirdSlot.toISOString() });
    }));
    const results = await settle(requests.map((row) => () => meetings.respond(host, row.id, { action: "ACCEPT" })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const error of failures(results))
      expect(error).toMatchObject({ status: 409, response: { code: "NETWORKING_SLOT_CONFLICT" } });
    expect(await networkingDoubleBookings(fixture.event.id)).toEqual([]);
  });
});
