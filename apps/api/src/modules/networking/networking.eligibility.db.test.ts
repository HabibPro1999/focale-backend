import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { NetworkingConfigSchema } from "@app/contracts";
import {
  clients,
  countNetworkingConnectionSummaries,
  eventAccess,
  forms,
  getDb,
  getNetworkingRecommendationProfiles,
  isNetworkingAccessAllowed,
  listNetworkingConnectionSummaries,
  listNetworkingDiscovery,
  networkingDirectoryFacets,
  networkingEmbeddings,
  networkingParticipantAccess,
  networkingParticipantExportContacts,
  networkingStore,
  networkingUnreadMessageCount,
  rankNetworkingVectorCandidates,
  registrations,
  type NetworkingRow,
} from "@app/db";
import {
  dbTestsEnabled,
  NETWORKING_ELIGIBILITY_MATRIX,
  networkingEligibilityRowFacts,
  type NetworkingEligibilityRow,
} from "@app/db/testing";
import { NetworkingService, type NetworkingContext } from "./networking.service";

/**
 * Plan 4.6: the declarative eligibility matrix, run against every read
 * surface that filters participants, in a real database (both engines in CI).
 * One eligible viewer; one target per matrix row. Each surface must agree with
 * the row's declared answer, which the pure policy is held to in unit tests.
 */
const service = new NetworkingService();
const model = "eligibility-matrix-model";
const ids = { client: randomUUID(), event: randomUUID(), other: randomUUID(), form: randomUUID(), access: randomUUID() };
const config = NetworkingConfigSchema.parse({
  enabled: true,
  approvalMode: "AUTOMATIC",
  timezone: "UTC",
  eligiblePaymentStatuses: ["PAID"],
  requiredAccessId: ids.access,
  fieldMapping: { consent: "consent" },
});
const statuses = config.eligiblePaymentStatuses;
const unit = (dimension: number) => Array.from({ length: 1536 }, (_, i) => (i === dimension ? 1 : 0));
type Target = { row: NetworkingEligibilityRow; profile: NetworkingRow<"profiles">; registrationId: string; connected: boolean };
let event: NetworkingRow<"events">;
let viewer: NetworkingRow<"profiles">;
let ctx: NetworkingContext;
const targets: Target[] = [];

async function insertParticipant(input: {
  id: string;
  email: string;
  registration: { eventId: string; paymentStatus: "PAID" | "PENDING"; networkingOptIn: boolean | null };
  profile: Partial<NetworkingRow<"profiles">>;
}) {
  const registrationId = randomUUID();
  await getDb().insert(registrations).values({
    id: registrationId,
    eventId: input.registration.eventId,
    formId: ids.form,
    email: input.email,
    firstName: String(input.profile.firstName ?? "Participant"),
    lastName: String(input.profile.lastName ?? "Test"),
    paymentStatus: input.registration.paymentStatus,
    networkingOptIn: input.registration.networkingOptIn,
    totalAmount: 0,
    priceBreakdown: {},
    accessTypeIds: [ids.access],
    // No consent answer: an unconsented registrant without an opt-in is undecided (K1b).
    formData: {},
  });
  const profile = await networkingStore().insert("profiles", {
    firstName: "Participant",
    lastName: "Test",
    company: "Company",
    jobTitle: "Director",
    sector: "Technology",
    offers: "Advice",
    seeks: "Partners",
    ...input.profile,
    id: input.id,
    eventId: ids.event,
    registrationId,
    email: input.email,
  });
  return { profile, registrationId };
}

describe.runIf(dbTestsEnabled())("networking eligibility matrix on every surface (4.6)", () => {
  beforeAll(async () => {
    const db = getDb();
    const store = networkingStore();
    await db.insert(clients).values({ id: ids.client, name: `Eligibility ${ids.event}`, enabledModules: ["networking", "registrations", "emails"] });
    for (const id of [ids.event, ids.other]) {
      const row = await store.insert("events", {
        id,
        clientId: ids.client,
        name: "Eligibility matrix",
        slug: `eligibility-${id}`,
        status: "OPEN",
        startDate: new Date("2031-05-05T00:00:00Z"),
        endDate: new Date("2031-05-06T00:00:00Z"),
      });
      if (id === ids.event) event = row;
    }
    await store.insert("configs", { eventId: ids.event, config });
    await db.insert(eventAccess).values({ id: ids.access, eventId: ids.event, name: "Networking area" });
    await db.insert(forms).values({
      id: ids.form,
      eventId: ids.event,
      name: "Registration",
      schema: {
        fields: [{
          id: "consent",
          type: "radio",
          options: [{ id: "o-yes", label: "J’accepte de participer au networking" }, { id: "o-no", label: "Je ne souhaite pas participer" }],
        }],
      },
    });
    const viewerId = randomUUID();
    ({ profile: viewer } = await insertParticipant({
      id: viewerId,
      email: `viewer-${viewerId}@example.invalid`,
      registration: { eventId: ids.event, paymentStatus: "PAID", networkingOptIn: true },
      profile: { status: "ACTIVE", consent: true, visible: true, firstName: "Viewer" },
    }));
    ctx = { event, config, profile: viewer, session: {} as NetworkingRow<"sessions"> };
    const embeddings: (typeof networkingEmbeddings.$inferInsert)[] = [];
    const embed = (profileId: string, dimension: number) => {
      for (const kind of ["PROFILE", "OFFER", "NEED"] as const)
        embeddings.push({ profileId, eventId: ids.event, kind, model, sourceHash: "matrix", embedding: unit(dimension) });
    };
    embed(viewer.id, 0);
    for (const [index, row] of NETWORKING_ELIGIBILITY_MATRIX.entries()) {
      const targetId = randomUUID();
      const facts = networkingEligibilityRowFacts(row, {
        eventId: ids.event,
        otherEventId: ids.other,
        targetId,
        viewer: { id: viewer.id, email: viewer.email },
      });
      const { overrides, ...profile } = facts.profile;
      const created = await insertParticipant({
        id: targetId,
        email: facts.profile.email,
        registration: facts.registration as { eventId: string; paymentStatus: "PAID" | "PENDING"; networkingOptIn: boolean | null },
        profile: { ...profile, status: facts.profile.status as NetworkingRow<"profiles">["status"], overrides },
      });
      targets.push({ row, profile: created.profile, registrationId: created.registrationId, connected: facts.connected });
      embed(targetId, index + 1);
      const [profileAId, profileBId] = viewer.id < targetId ? [viewer.id, targetId] : [targetId, viewer.id];
      if (facts.connected) {
        const connection = await store.insert("connections", { eventId: ids.event, profileAId, profileBId });
        await store.insert("messages", { eventId: ids.event, connectionId: connection.id, senderId: targetId, body: "Hello", clientMessageId: randomUUID() });
      }
      if (facts.liked) await store.insert("interests", { eventId: ids.event, profileId: viewer.id, targetId, action: "LIKE" });
      if (row.relation?.viewerBlocked) await store.insert("blocks", { eventId: ids.event, profileId: viewer.id, targetId });
      if (row.relation?.blockedViewer) await store.insert("blocks", { eventId: ids.event, profileId: targetId, targetId: viewer.id });
      if (facts.confirmedMeeting) {
        const startsAt = new Date(Date.parse("2031-05-05T09:00:00Z") + index * 1_800_000);
        await store.insert("meetings", {
          eventId: ids.event,
          requesterId: viewer.id,
          recipientId: targetId,
          status: "CONFIRMED",
          startsAt,
          endsAt: new Date(+startsAt + 1_800_000),
          expiresAt: startsAt,
        });
      }
    }
    await db.insert(networkingEmbeddings).values(embeddings);
  });

  const expected = (surface: keyof NetworkingEligibilityRow["expect"], filter: (target: Target) => boolean = () => true) =>
    Object.fromEntries(targets.map((target) => [target.row.name, filter(target) && target.row.expect[surface] === true]));
  const actual = (present: (target: Target) => boolean) =>
    Object.fromEntries(targets.map((target) => [target.row.name, present(target)]));
  const idsOf = (rows: { id: string }[]) => new Set(rows.map((row) => row.id));

  it("builds one target per matrix row", () => {
    expect(targets.map((target) => target.row.name)).toEqual(NETWORKING_ELIGIBILITY_MATRIX.map((row) => row.name));
  });

  it("participant access: each target's own sign-in (snapshot + policy)", async () => {
    const store = networkingStore();
    const access: Record<string, unknown> = {};
    for (const target of targets) {
      const snapshot = await store.participantSnapshot({ eventId: ids.event, clientId: ids.client, profileId: target.profile.id });
      access[target.row.name] = snapshot ? networkingParticipantAccess(snapshot, snapshot.config) : "missing";
    }
    expect(access).toEqual(Object.fromEntries(targets.map((target) => [target.row.name, target.row.expect.access])));
  });

  it("service target(): profile mode, and discover mode for swipes", async () => {
    const seen = async (visible: boolean) => {
      const result: Record<string, boolean> = {};
      for (const target of targets) {
        try {
          await service.target(ctx, target.profile.id, networkingStore(), visible);
          result[target.row.name] = true;
        } catch (error) {
          if (!(error instanceof NotFoundException)) throw error;
          result[target.row.name] = false;
        }
      }
      return result;
    };
    expect(await seen(false)).toEqual(expected("profile"));
    expect(await seen(true)).toEqual(expected("discover"));
  });

  it("service blockedTarget(): the block list", async () => {
    const result: Record<string, boolean> = {};
    for (const target of targets) result[target.row.name] = (await service.blockedTarget(ctx, target.profile.id)) !== null;
    expect(result).toEqual(expected("blocklist"));
  });

  it("discovery lists, search, facets and fresh discovery", async () => {
    const listed = idsOf((await listNetworkingDiscovery(ids.event, viewer.id, statuses, { limit: 100 })).items);
    expect(actual((target) => listed.has(target.profile.id))).toEqual(expected("discover"));
    const searched = idsOf((await listNetworkingDiscovery(ids.event, viewer.id, statuses, { q: "Target", sort: "recommended", limit: 100 })).items);
    expect(actual((target) => searched.has(target.profile.id))).toEqual(expected("discover"));
    const fresh = idsOf((await listNetworkingDiscovery(ids.event, viewer.id, statuses, { excludeInteracted: true, limit: 100 })).items);
    expect(actual((target) => fresh.has(target.profile.id))).toEqual(expected("fresh"));
    const sectors = new Set((await networkingDirectoryFacets(ids.event, viewer.id, statuses)).sectors.map((facet) => facet.value));
    expect(actual((target) => sectors.has(target.profile.sector))).toEqual(expected("discover"));
  });

  it("recommendations: vector ranking and the recommended profiles", async () => {
    const ranked = new Set((await rankNetworkingVectorCandidates(ids.event, viewer.id, model, statuses, 100)).map((row) => row.profileId));
    expect(actual((target) => ranked.has(target.profile.id))).toEqual(expected("fresh"));
    const profiles = idsOf(await getNetworkingRecommendationProfiles(ids.event, targets.map((target) => target.profile.id), viewer.id, statuses));
    expect(actual((target) => profiles.has(target.profile.id))).toEqual(expected("fresh"));
  });

  it("connections, their count, unread messages and the contacts CSV: peer mode over the viewer's connections", async () => {
    const connected = (target: Target) => target.connected;
    const summaries = await listNetworkingConnectionSummaries(ids.event, viewer.id, statuses);
    const listed = new Set(summaries.map((summary) => summary.profile.id));
    expect(actual((target) => listed.has(target.profile.id))).toEqual(expected("peer", connected));
    expect(summaries.every((summary) => summary.unreadCount === 1)).toBe(true);
    const visible = targets.filter((target) => target.connected && target.row.expect.peer).length;
    expect(await countNetworkingConnectionSummaries(ids.event, viewer.id, statuses)).toBe(visible);
    expect(await networkingUnreadMessageCount(ids.event, viewer.id)).toBe(visible);
    // The post-event contacts CSV (each target's last name is its row name).
    const contacts = new Set((await networkingParticipantExportContacts(ids.event, viewer.id)).map((row) => row.lastName));
    expect(actual((target) => contacts.has(target.row.name))).toEqual(expected("peer", connected));
  });

  it("area admission: the badge and the check-in scan", async () => {
    const badge: Record<string, boolean> = {}, scan: Record<string, boolean> = {};
    for (const target of targets) {
      badge[target.row.name] = await service.areaAccess({ event, config, profile: target.profile });
      scan[target.row.name] = await isNetworkingAccessAllowed(ids.event, target.registrationId, ids.access);
    }
    expect(badge).toEqual(expected("admitted"));
    expect(scan).toEqual(expected("admitted"));
  });

  it("refuses every counterpart to a viewer who lost eligibility", async () => {
    const store = networkingStore();
    const eligibleTarget = targets.find((target) => target.row.name === "eligible")!;
    await store.update("profiles", { eventId: ids.event, id: viewer.id }, { status: "SUSPENDED" });
    try {
      await expect(service.target(ctx, eligibleTarget.profile.id)).rejects.toMatchObject({
        status: 403,
        response: { code: "NETWORKING_NOT_ELIGIBLE" },
      });
      await expect(service.blockedTarget(ctx, eligibleTarget.profile.id)).rejects.toMatchObject({ status: 403 });
    } finally {
      await store.update("profiles", { eventId: ids.event, id: viewer.id }, { status: "ACTIVE" });
    }
  });
});
