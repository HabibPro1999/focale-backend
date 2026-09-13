import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { NetworkingConfigSchema } from "@app/contracts";
import {
  clients,
  events,
  forms,
  registrations,
  getDb,
  networkingProfiles,
  networkingEmbeddings,
  networkingEmbeddingJobs,
  networkingBlocks,
  networkingInterests,
  networkingConfigs,
  reindexNetworkingEvent,
  claimNetworkingEmbeddingJobs,
  enqueueChangedNetworkingEmbeddings,
  getNetworkingRecommendationProfiles,
  findNetworkingVectorCandidates,
} from "../../../src";
import { dbTestsEnabled } from "../../helpers/test-env";

const ids = {
  client: randomUUID(),
  event: randomUUID(),
  otherEvent: randomUUID(),
  form: randomUUID(),
  otherForm: randomUUID(),
};
const model = "test-complementary-model";
const participants = new Map<
  string,
  { id: string; registrationId: string; eventId: string }
>();
const vector = (dimension: number) =>
  Array.from({ length: 1536 }, (_, i) => (i === dimension ? 1 : 0));

async function participant(
  name: string,
  options: {
    eventId?: string;
    paymentStatus?: "PAID" | "PENDING";
    visible?: boolean;
  } = {},
) {
  const db = getDb();
  const eventId = options.eventId ?? ids.event;
  const registrationId = randomUUID();
  const id = randomUUID();
  await db
    .insert(registrations)
    .values({
      id: registrationId,
      eventId,
      formId: eventId === ids.event ? ids.form : ids.otherForm,
      email: `${id}@example.test`,
      firstName: name,
      paymentStatus: options.paymentStatus ?? "PAID",
      totalAmount: 0,
      priceBreakdown: {},
      formData: {},
    });
  await db
    .insert(networkingProfiles)
    .values({
      id,
      eventId,
      registrationId,
      email: `${id}@example.test`,
      firstName: name,
      status: "ACTIVE",
      consent: true,
      visible: options.visible ?? true,
      offers: name === "Founder" ? "Product expertise" : "Funding",
      seeks: name === "Founder" ? "Funding" : "Product expertise",
    });
  await db
    .insert(networkingEmbeddingJobs)
    .values({
      profileId: id,
      status: "READY",
      model,
      sourceHash: "fixture",
      indexedProfileAt: new Date(),
    });
  for (const [kind, dimension] of [
    ["PROFILE", 2],
    ["OFFER", name === "Founder" ? 3 : 0],
    ["NEED", name === "Founder" ? 0 : 3],
  ] as const) {
    await db
      .insert(networkingEmbeddings)
      .values({
        profileId: id,
        eventId,
        model,
        kind,
        sourceHash: "fixture",
        embedding: vector(dimension),
      });
  }
  participants.set(name, { id, registrationId, eventId });
  return id;
}

describe.runIf(dbTestsEnabled())("networking native vector retrieval", () => {
  beforeAll(async () => {
    const db = getDb();
    await db
      .insert(clients)
      .values({
        id: ids.client,
        name: "Networking vector test",
        enabledModules: ["networking", "registrations", "emails"],
      });
    for (const [eventId, formId] of [
      [ids.event, ids.form],
      [ids.otherEvent, ids.otherForm],
    ]) {
      await db
        .insert(events)
        .values({
          id: eventId!,
          clientId: ids.client,
          name: "Isolated test event",
          slug: eventId!,
          startDate: new Date(),
          endDate: new Date(Date.now() + 86_400_000),
          status: "OPEN",
        });
      await db
        .insert(forms)
        .values({
          id: formId!,
          eventId: eventId!,
          name: "Test registration",
          schema: { steps: [] },
          type: "REGISTRATION",
        });
    }
    await db
      .insert(networkingConfigs)
      .values({
        eventId: ids.event,
        config: NetworkingConfigSchema.parse({ enabled: true }),
      });
    const founder = await participant("Founder");
    await participant("Investor");
    const shared = await participant("Shared email");
    await db.update(networkingProfiles).set({ email: `${founder}@EXAMPLE.TEST` }).where(eq(networkingProfiles.id, shared));
    await participant("Unpaid", { paymentStatus: "PENDING" });
    await participant("Hidden", { visible: false });
    await participant("Other event", { eventId: ids.otherEvent });
    const blocked = await participant("Blocked");
    await db
      .insert(networkingBlocks)
      .values({ eventId: ids.event, profileId: blocked, targetId: founder });
    const ignored = await participant("Ignored");
    await db
      .insert(networkingInterests)
      .values({
        eventId: ids.event,
        profileId: founder,
        targetId: ignored,
        action: "PASS",
      });
  });
  afterAll(async () => {
    const db = getDb();
    for (const id of [ids.event, ids.otherEvent]) {
      await db.delete(registrations).where(eq(registrations.eventId, id));
      await db.delete(forms).where(eq(forms.eventId, id));
      await db.delete(events).where(eq(events.id, id));
    }
    await db.delete(clients).where(eq(clients.id, ids.client));
  });
  it("matches complementary offers/needs and enforces event, payment, visibility, shared-email, block and pass filters in SQL", async () => {
    const matches = await findNetworkingVectorCandidates(
      ids.event,
      participants.get("Founder")!.id,
      model,
      ["PAID"],
    );
    expect(matches?.map((row) => row.profileId)).toEqual([
      participants.get("Investor")!.id,
    ]);
    expect(matches![0]!.score).toBeCloseTo(1);
    expect(matches![0]!.needsScore).toBeCloseTo(1);
    expect(matches![0]!.offersScore).toBeCloseTo(1);
  });
  it("does not compare vectors from different embedding models", async () => {
    expect(
      await findNetworkingVectorCandidates(
        ids.event,
        participants.get("Founder")!.id,
        "different-model",
        ["PAID"],
      ),
    ).toBeNull();
  });
  it("rechecks payment, blocks, consent, visibility, event and shared email during final hydration", async () => {
    const db = getDb();
    const founderId = participants.get("Founder")!.id;
    const idsToHydrate = [...participants.values()].map(p => p.id);
    const eligibleIds = () => getNetworkingRecommendationProfiles(ids.event, idsToHydrate, founderId, ["PAID"]);
    const investor = participants.get("Investor")!;
    // PASS is a ranking exclusion; final hydration independently rechecks the privacy/eligibility boundary.
    expect((await eligibleIds()).map(p => p.id).sort()).toEqual([investor.id, participants.get("Ignored")!.id].sort());
    await db.update(registrations).set({ paymentStatus: "PENDING" }).where(eq(registrations.id, investor.registrationId));
    expect((await eligibleIds()).map(p => p.id)).not.toContain(investor.id);
    await db.update(registrations).set({ paymentStatus: "PAID" }).where(eq(registrations.id, investor.registrationId));
    await db.insert(networkingBlocks).values({ eventId: ids.event, profileId: founderId, targetId: investor.id });
    expect((await eligibleIds()).map(p => p.id)).not.toContain(investor.id);
    await db.delete(networkingBlocks).where(eq(networkingBlocks.targetId, investor.id));
    await db.update(networkingProfiles).set({ consent: false }).where(eq(networkingProfiles.id, investor.id));
    expect((await eligibleIds()).map(p => p.id)).not.toContain(investor.id);
    await db.update(networkingProfiles).set({ consent: true }).where(eq(networkingProfiles.id, investor.id));
  });
  it("terminalizes exhausted expired leases while allowing the last remaining attempt", async () => {
    const db = getDb();
    const founderId = participants.get("Founder")!.id;
    await db.update(networkingEmbeddingJobs).set({ status: "PROCESSING", attempts: 5, lockToken: "expired", lockedUntil: new Date(0) }).where(eq(networkingEmbeddingJobs.profileId, founderId));
    expect((await claimNetworkingEmbeddingJobs(100)).map(j => j.profile.id)).not.toContain(founderId);
    const [job] = await db.select().from(networkingEmbeddingJobs).where(eq(networkingEmbeddingJobs.profileId, founderId));
    expect(job).toMatchObject({ status: "FAILED", attempts: 5, lockedUntil: null, lockToken: null });
    await db.update(networkingEmbeddingJobs).set({ status: "PROCESSING", attempts: 4, availableAt: new Date(0), lockToken: "expired", lockedUntil: new Date(0) }).where(eq(networkingEmbeddingJobs.profileId, founderId));
    expect((await claimNetworkingEmbeddingJobs(100)).map(j => j.profile.id)).toContain(founderId);
  });
  it("does not enqueue or claim when either required client dependency is revoked", async () => {
    const db = getDb();
    const founderId = participants.get("Founder")!.id;
    for (const modules of [["networking", "emails"], ["networking", "registrations"]] as const) {
      await db.update(clients).set({ enabledModules: [...modules] }).where(eq(clients.id, ids.client));
      await db.delete(networkingEmbeddingJobs).where(eq(networkingEmbeddingJobs.profileId, founderId));
      await enqueueChangedNetworkingEmbeddings(model);
      expect(await db.select().from(networkingEmbeddingJobs).where(eq(networkingEmbeddingJobs.profileId, founderId))).toHaveLength(0);
      await reindexNetworkingEvent(ids.event);
      expect((await claimNetworkingEmbeddingJobs(100)).filter(job => job.profile.eventId === ids.event)).toHaveLength(0);
    }
    await db.update(clients).set({ enabledModules: ["networking", "registrations", "emails"] }).where(eq(clients.id, ids.client));
  });
  it("revalidates consent and payment before claiming a queued embedding batch", async () => {
    await reindexNetworkingEvent(ids.event);
    await getDb()
      .update(networkingProfiles)
      .set({ consent: false })
      .where(eq(networkingProfiles.id, participants.get("Investor")!.id));
    const jobs = await claimNetworkingEmbeddingJobs(100);
    const claimedIds = jobs
      .filter((job) => job.profile.eventId === ids.event)
      .map((job) => job.profile.id);
    expect(claimedIds).toContain(participants.get("Founder")!.id);
    expect(claimedIds).not.toContain(participants.get("Investor")!.id);
    expect(claimedIds).not.toContain(participants.get("Unpaid")!.id);
    expect(claimedIds).not.toContain(participants.get("Hidden")!.id);
  });
});
