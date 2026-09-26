import { randomUUID } from "node:crypto";
import type { NetworkingConfig } from "@app/contracts";
import { forms, getDb, networkingStore, registrations, type NetworkingRow } from "@app/db";
import {
  NETWORKING_ELIGIBILITY_MATRIX,
  networkingEligibilityRowFacts,
  type NetworkingEligibilityRow,
} from "@app/db/testing";

/**
 * The networking eligibility matrix (plan 4.6) as database rows: one eligible
 * viewer and one target per matrix row in an event. Shared by the DB tests
 * that run a surface over it (eligibility on every surface, 4.9 analytics).
 */
export type MatrixTarget = {
  row: NetworkingEligibilityRow;
  profile: NetworkingRow<"profiles">;
  registrationId: string;
  connected: boolean;
  connectionId?: string;
  meeting?: NetworkingRow<"meetings">;
};
export type Matrix = { event: NetworkingRow<"events">; viewer: NetworkingRow<"profiles">; targets: MatrixTarget[]; formId: string };
/** The client, the other event (registrations that belong elsewhere) and the access item every registration holds. */
export type MatrixScope = { clientId: string; otherEventId: string; accessId: string };

export async function insertMatrixParticipant(scope: MatrixScope, input: {
  eventId: string;
  formId: string;
  id: string;
  email: string;
  registration: { eventId: string; paymentStatus: "PAID" | "PENDING"; networkingOptIn: boolean | null };
  profile: Partial<NetworkingRow<"profiles">>;
}) {
  const registrationId = randomUUID();
  await getDb().insert(registrations).values({
    id: registrationId,
    eventId: input.registration.eventId,
    formId: input.formId,
    email: input.email,
    firstName: String(input.profile.firstName ?? "Participant"),
    lastName: String(input.profile.lastName ?? "Test"),
    paymentStatus: input.registration.paymentStatus,
    networkingOptIn: input.registration.networkingOptIn,
    totalAmount: 0,
    priceBreakdown: {},
    accessTypeIds: [scope.accessId],
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
    eventId: input.eventId,
    registrationId,
    email: input.email,
  });
  return { profile, registrationId };
}

/** One eligible viewer and one target per matrix row, in `eventId` (which this creates). */
export async function buildEligibilityMatrix(scope: MatrixScope, input: {
  eventId: string;
  config: NetworkingConfig;
  startDate: Date;
  endDate: Date;
  meetingAt: (index: number) => { startsAt: Date; createdAt?: Date };
  profile?: Partial<NetworkingRow<"profiles">>;
}): Promise<Matrix> {
  const db = getDb();
  const store = networkingStore();
  const formId = randomUUID();
  const event = await store.insert("events", {
    id: input.eventId,
    clientId: scope.clientId,
    name: "Eligibility matrix",
    slug: `eligibility-${input.eventId}`,
    status: "OPEN",
    startDate: input.startDate,
    endDate: input.endDate,
  });
  await store.insert("configs", { eventId: input.eventId, config: input.config });
  await db.insert(forms).values({
    id: formId,
    eventId: input.eventId,
    name: "Registration",
    schema: {
      fields: [{
        id: "consent",
        type: "radio",
        options: [{ id: "o-yes", label: "J’accepte de participer au networking" }, { id: "o-no", label: "Je ne souhaite pas participer" }],
      }],
    } as never,
  });
  const viewerId = randomUUID();
  const { profile: viewer } = await insertMatrixParticipant(scope, {
    eventId: input.eventId,
    formId,
    id: viewerId,
    email: `viewer-${viewerId}@example.invalid`,
    registration: { eventId: input.eventId, paymentStatus: "PAID", networkingOptIn: true },
    profile: { ...input.profile, status: "ACTIVE", consent: true, visible: true, firstName: "Viewer" },
  });
  const targets: MatrixTarget[] = [];
  for (const [index, row] of NETWORKING_ELIGIBILITY_MATRIX.entries()) {
    const targetId = randomUUID();
    const facts = networkingEligibilityRowFacts(row, {
      eventId: input.eventId,
      otherEventId: scope.otherEventId,
      targetId,
      viewer: { id: viewer.id, email: viewer.email },
    });
    const { overrides, ...profile } = facts.profile;
    const created = await insertMatrixParticipant(scope, {
      eventId: input.eventId,
      formId,
      id: targetId,
      email: facts.profile.email,
      registration: facts.registration as { eventId: string; paymentStatus: "PAID" | "PENDING"; networkingOptIn: boolean | null },
      profile: { ...input.profile, ...profile, status: facts.profile.status as NetworkingRow<"profiles">["status"], overrides },
    });
    const target: MatrixTarget = { row, profile: created.profile, registrationId: created.registrationId, connected: facts.connected };
    targets.push(target);
    const [profileAId, profileBId] = viewer.id < targetId ? [viewer.id, targetId] : [targetId, viewer.id];
    if (facts.connected) {
      const connection = await store.insert("connections", { eventId: input.eventId, profileAId, profileBId });
      target.connectionId = connection.id;
      await store.insert("messages", { eventId: input.eventId, connectionId: connection.id, senderId: targetId, body: "Hello", clientMessageId: randomUUID() });
    }
    if (facts.liked) await store.insert("interests", { eventId: input.eventId, profileId: viewer.id, targetId, action: "LIKE" });
    if (row.relation?.viewerBlocked) await store.insert("blocks", { eventId: input.eventId, profileId: viewer.id, targetId });
    if (row.relation?.blockedViewer) await store.insert("blocks", { eventId: input.eventId, profileId: targetId, targetId: viewer.id });
    if (facts.confirmedMeeting) {
      const { startsAt, createdAt } = input.meetingAt(index);
      target.meeting = await store.insert("meetings", {
        eventId: input.eventId,
        requesterId: viewer.id,
        recipientId: targetId,
        status: "CONFIRMED",
        startsAt,
        endsAt: new Date(+startsAt + 1_800_000),
        expiresAt: startsAt,
        ...(createdAt ? { createdAt } : {}),
      });
    }
  }
  return { event, viewer, targets, formId };
}
