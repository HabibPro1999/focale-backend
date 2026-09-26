import { randomBytes, randomUUID } from "node:crypto";
import { NetworkingConfigSchema, type NetworkingConfig } from "@app/contracts";
import { getDb } from "../../src/client";
import { clients } from "../../src/schema/users-clients";
import { forms } from "../../src/schema/forms";
import { registrations } from "../../src/schema/registrations";
import { syncNetworkingEvent } from "../../src/queries/networking";
import { networkingStore, type NetworkingRow } from "../../src/queries/networking-store";

export type NetworkingWriteParticipant = {
  profile: NetworkingRow<"profiles">;
  session: NetworkingRow<"sessions">;
  token: string;
};

/**
 * An isolated networking event for write-path tests: `size` consented, paid
 * participants (synced from registrations), each available at every slot in
 * `slots`, with a live session, plus `tables` ordinary tables. The caller
 * supplies the session hash so the fixture needs no API code.
 */
export async function createNetworkingWriteFixture(options: {
  size: number;
  slots: Date[];
  tables: number;
  hash: (token: string) => string;
  config?: Partial<NetworkingConfig>;
}) {
  const db = getDb();
  const store = networkingStore();
  const clientId = randomUUID(), eventId = randomUUID(), formId = randomUUID();
  const days = [...new Set(options.slots.map((slot) => slot.toISOString().slice(0, 10)))];
  const config = NetworkingConfigSchema.parse({
    enabled: true,
    approvalMode: "AUTOMATIC",
    timezone: "UTC",
    meetingsEnabled: true,
    autoAssignTables: true,
    fieldMapping: { company: "company", jobTitle: "jobTitle", sector: "sector" },
    openingHours: days.map((date) => ({ date, start: "00:00", end: "23:55" })),
    ...options.config,
  });
  await db.insert(clients).values({
    id: clientId,
    name: `Networking writes ${eventId}`,
    enabledModules: ["networking", "registrations", "emails"],
  });
  const first = Math.min(...options.slots.map((slot) => slot.getTime()));
  const last = Math.max(...options.slots.map((slot) => slot.getTime()));
  const event = await store.insert("events", {
    id: eventId,
    clientId,
    name: "Networking writes",
    slug: `networking-writes-${eventId}`,
    status: "OPEN",
    startDate: new Date(Math.floor(first / 86_400_000) * 86_400_000),
    endDate: new Date(Math.floor(last / 86_400_000) * 86_400_000 + 86_400_000),
  });
  await store.insert("configs", { eventId, config });
  await db.insert(forms).values({
    id: formId,
    eventId,
    name: "Registration",
    schema: { steps: [{ id: "professional", fields: ["company", "jobTitle", "sector"].map((id) => ({ id, type: "text" })) }] } as never,
  });
  await db.insert(registrations).values(Array.from({ length: options.size }, (_, index) => ({
    id: randomUUID(),
    eventId,
    formId,
    email: `writes-${eventId}-${String(index).padStart(3, "0")}@example.invalid`,
    firstName: `Participant ${String(index).padStart(3, "0")}`,
    lastName: "Writes",
    paymentStatus: "PAID" as const,
    totalAmount: 0,
    priceBreakdown: {},
    networkingOptIn: true,
    formData: { company: "Company", jobTitle: "Director", sector: "Technology" },
  })));
  await syncNetworkingEvent(eventId);
  const profiles = (await store.all("profiles", { eventId }))
    .sort((a, b) => a.firstName.localeCompare(b.firstName));
  const participants: NetworkingWriteParticipant[] = [];
  for (const profile of profiles) {
    await store.update("profiles", { eventId, id: profile.id }, { availabilitySet: true });
    if (options.slots.length)
      await store.insertAvailability(options.slots.map((startsAt) => ({ eventId, profileId: profile.id, startsAt })));
    const token = randomBytes(48).toString("base64url");
    const session = await store.insert("sessions", {
      eventId,
      profileId: profile.id,
      tokenHash: options.hash(token),
      expiresAt: new Date(last + 86_400_000),
    });
    participants.push({ profile: { ...profile, availabilitySet: true }, session, token });
  }
  const tables: NetworkingRow<"tables">[] = [];
  for (let index = 0; index < options.tables; index++)
    tables.push(await store.insert("tables", {
      eventId,
      name: `Table ${String(index + 1).padStart(2, "0")}`,
      capacity: 2,
    }));
  return { event, config, participants, tables };
}

/**
 * Double bookings among meetings that still hold resources: two overlapping
 * meetings on one table, or two overlapping confirmed meetings sharing a
 * participant. Must always be empty.
 */
export async function networkingDoubleBookings(eventId: string) {
  const { rows } = await getDb().$client.query(
    `SELECT a.id AS first, b.id AS second
       FROM networking_meetings a
       JOIN networking_meetings b ON b.event_id = a.event_id AND a.id < b.id
        AND a.starts_at < b.ends_at AND b.starts_at < a.ends_at
      WHERE a.event_id = $1
        AND a.status NOT IN ('CANCELLED','DECLINED','EXPIRED')
        AND b.status NOT IN ('CANCELLED','DECLINED','EXPIRED')
        AND ((a.table_id IS NOT NULL AND a.table_id = b.table_id)
          OR (a.status IN ('CONFIRMED','COMPLETED','NO_SHOW') AND b.status IN ('CONFIRMED','COMPLETED','NO_SHOW')
              AND (a.requester_id IN (b.requester_id, b.recipient_id) OR a.recipient_id IN (b.requester_id, b.recipient_id))))`,
    [eventId],
  );
  return rows;
}
