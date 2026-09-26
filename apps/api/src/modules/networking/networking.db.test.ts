import { beforeAll, describe, expect, it } from "vitest";
import {
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  updateClientRow,
  clients,
  forms,
  registrations,
  getDb,
  networkingAllocationTransaction,
  networkingStore,
  syncNetworkingEvent,
  type NetworkingRow,
} from "@app/db";
import { NetworkingConfigSchema } from "@app/contracts";
import {
  NetworkingService,
  type NetworkingContext,
} from "./networking.service";
import { NetworkingSocialService } from "./networking.social.service";
import { NetworkingMeetingsService } from "./networking.meetings.service";
import { NetworkingAdminService } from "./networking.admin.service";
import { NetworkingExportsService } from "./networking.exports.service";
import { NetworkingMfaService } from "./networking.mfa.service";
import {
  openNetworkingSecret,
  networkingTotp,
  networkingHash,
} from "./networking.security";
import { dbTestsEnabled } from "@app/db/testing";
const enabled = dbTestsEnabled();
const mfa = new NetworkingMfaService();
const service = new NetworkingService();
const social = new NetworkingSocialService(service);
const meetings = new NetworkingMeetingsService(service);
const admin = new NetworkingAdminService(service, meetings);
const ids = {
  client: randomUUID(),
  event: randomUUID(),
  other: randomUUID(),
  form: randomUUID(),
};
let event: NetworkingRow<"events">;
const participants: NetworkingContext[] = [];
const config = NetworkingConfigSchema.parse({
  enabled: true,
  approvalMode: "AUTOMATIC",
  timezone: "UTC",
  fieldMapping: { company: "company", jobTitle: "jobTitle", sector: "sector" },
  openingHours: [{ date: "2031-04-05", start: "09:00", end: "17:00" }],
});
async function pair(a: number, b: number) {
  await Promise.all([
    social.interest(participants[a], participants[b].profile.id, "LIKE"),
    social.interest(participants[b], participants[a].profile.id, "LIKE"),
  ]);
}
const slot = (time: string) => `2031-04-05T${time}:00.000Z`;
describe.runIf(enabled)(
  "networking real database authorization and booking",
  () => {
    beforeAll(async () => {
      process.env.NETWORKING_TOKEN_SECRET =
        "test-networking-secret-at-least-32-characters";
      const db = getDb();
      await db.insert(clients).values({
        id: ids.client,
        name: "Networking isolation tests",
        enabledModules: ["networking", "registrations", "emails"],
      });
      for (const id of [ids.event, ids.other]) {
        const row = await networkingStore().insert("events", {
          id,
          clientId: ids.client,
          name: "Networking fixture",
          slug: id,
          status: "OPEN",
          startDate: new Date("2031-04-05T00:00Z"),
          endDate: new Date("2031-04-06T00:00Z"),
        });
        if (id === ids.event) event = row;
        await networkingStore().insert("configs", { eventId: id, config });
      }
      await db.insert(forms).values({
        id: ids.form,
        eventId: ids.event,
        name: "Registration",
        schema: { steps: [{ id: "professional", fields: ["company", "jobTitle", "sector"].map(id => ({ id, type: "text" })) }] } as never,
      });
      for (let i = 0; i < 8; i++)
        await db.insert(registrations).values({
          id: randomUUID(),
          eventId: ids.event,
          formId: ids.form,
          email: `networking-${ids.event}-${i}@example.invalid`,
          firstName: `Participant ${i}`,
          lastName: "Test",
          paymentStatus: "PAID",
          totalAmount: 0,
          priceBreakdown: {},
          // Unmapped consent is undecided (K1): fixtures opt in explicitly, as the form checkbox does.
          networkingOptIn: true,
          formData: { company: "Test company", jobTitle: "Director", sector: "Technology" },
        });
      await syncNetworkingEvent(ids.event);
      const profiles = (
        await networkingStore().all("profiles", { eventId: ids.event })
      ).sort((a, b) => a.firstName.localeCompare(b.firstName));
      for (const profile of profiles) {
        profile.availabilitySet = true;
        await networkingStore().update(
          "profiles",
          { eventId: ids.event, id: profile.id },
          { availabilitySet: true },
        );
        for (let minute = 9 * 60; minute < 17 * 60; minute += 30)
          await networkingStore().insert("availability", {
            eventId: ids.event,
            profileId: profile.id,
            startsAt: new Date(
              `2031-04-05T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`,
            ),
          });
        const token =
          randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
        const session = await networkingStore().insert("sessions", {
          eventId: ids.event,
          profileId: profile.id,
          tokenHash: networkingHash(token),
          expiresAt: new Date("2031-04-06T00:00Z"),
        });
        participants.push({ event, config, profile, session });
      }
      await networkingStore().insert("tables", {
        eventId: ids.event,
        name: "Whole table",
        capacity: 2,
      });
    }, 30000);
    it("creates one mutual connection under concurrent likes", async () => {
      await pair(0, 1);
      const matches = await networkingStore().all("connections", {
        eventId: ids.event,
      });
      expect(matches).toHaveLength(1);
      expect((await social.connections(participants[0])).total).toBe(1);
      await social.interest(
        participants[0],
        participants[1].profile.id,
        "LIKE",
      );
      expect(
        await networkingStore().all("audit", {
          eventId: ids.event,
          action: "SWIPE_LIKE",
        }),
      ).toHaveLength(2);
    });
    it("does not grant sessions across events or to refunded registrants", async () => {
      const p = participants[7];
      const token = randomBytes(48).toString("base64url");
      await networkingStore().insert("sessions", {
        eventId: ids.event,
        profileId: p.profile.id,
        tokenHash: networkingHash(token),
        expiresAt: new Date("2031-04-06T00:00Z"),
      });
      expect(
        (await service.participant(ids.event, `Bearer ${token}`)).profile.id,
      ).toBe(p.profile.id);
      await expect(
        service.participant(ids.other, `Bearer ${token}`),
      ).rejects.toThrow("expired");
      await networkingStore().update(
        "registrations",
        { id: p.profile.registrationId, eventId: ids.event },
        { paymentStatus: "REFUNDED" },
      );
      await expect(
        service.participant(ids.event, `Bearer ${token}`),
      ).rejects.toThrow("eligible");
    });
    it("persists wrong OTP attempts, authenticates once, and rejects replay", async () => {
      const request = await service.requestCode(
        ids.event,
        participants[0].profile.email,
      );
      const delivery = await networkingStore().one("deliveries", {
        dedupeKey: `otp:${request.challengeId}`,
      });
      expect(delivery).not.toBeNull();
      const [iv, tag, encrypted] = String(delivery!.payload.encryptedCode)
        .split(".")
        .map((v) => Buffer.from(v, "base64url"));
      const decipher = createDecipheriv(
        "aes-256-gcm",
        createHash("sha256")
          .update(process.env.NETWORKING_TOKEN_SECRET!)
          .digest(),
        iv,
      );
      decipher.setAuthTag(tag);
      const code = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]).toString();
      await expect(
        service.verifyCode(
          ids.event,
          request.challengeId,
          code === "000000" ? "111111" : "000000",
        ),
      ).rejects.toThrow("Invalid");
      expect(
        (await networkingStore().one("challenges", { id: request.challengeId }))
          ?.attempts,
      ).toBe(1);
      expect(
        (await service.verifyCode(ids.event, request.challengeId, code)).token,
      ).toHaveLength(64);
      await expect(
        service.verifyCode(ids.event, request.challengeId, code),
      ).rejects.toThrow("Invalid");
    });
    it("requires authenticator verification, prevents replay and consumes recovery codes once", async () => {
      const profile = participants[6];
      const token = randomBytes(48).toString("base64url");
      const session = await networkingStore().insert("sessions", {
        eventId: ids.event,
        profileId: profile.profile.id,
        tokenHash: networkingHash(token),
        expiresAt: new Date("2031-04-06T00:00Z"),
      });
      const ctx = { ...profile, session };
      const enrollment = await mfa.enroll(ctx);
      expect((await mfa.enroll(ctx)).secret).toBe(enrollment.secret);
      const result = await mfa.verify(
        ctx,
        networkingTotp(enrollment.secret),
        "CONFIRM",
      );
      expect(result.recoveryCodes).toHaveLength(10);
      await networkingStore().update(
        "sessions",
        { id: session.id },
        { secondFactorVerifiedAt: null },
      );
      await expect(
        service.participant(ids.event, `Bearer ${token}`),
      ).rejects.toThrow("Authenticator");
      const restricted = await service.participant(
        ids.event,
        `Bearer ${token}`,
        { allowPendingSecondFactor: true },
      );
      await expect(
        mfa.verify(restricted, networkingTotp(enrollment.secret)),
      ).rejects.toThrow("reused");
      await mfa.verify(restricted, result.recoveryCodes![0]);
      expect(
        (await service.participant(ids.event, `Bearer ${token}`)).session
          .secondFactorVerifiedAt,
      ).not.toBeNull();
      await expect(
        mfa.verify(restricted, result.recoveryCodes![0]),
      ).rejects.toThrow("reused");
      expect(
        (
          await networkingStore().one("secondFactors", {
            profileId: profile.profile.id,
          })
        )?.recoveryHashes,
      ).toHaveLength(9);
    });
    it("reserves the entire table once under concurrent requests", async () => {
      await pair(2, 3);
      const results = await Promise.allSettled([
        meetings.create(participants[0], { profileId: participants[1].profile.id, startsAt: slot("09:00") }),
        meetings.create(participants[2], { profileId: participants[3].profile.id, startsAt: slot("09:00") }),
      ]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      const winner = results.find(result => result.status === "fulfilled")! as PromiseFulfilledResult<Awaited<ReturnType<typeof meetings.create>>>;
      const recipient = participants.find(person => person.profile.id === winner.value.recipientId)!;
      await meetings.respond(recipient, winner.value.id, { action: "ACCEPT" });
      expect(await networkingStore().all("meetings", { eventId: ids.event, status: "CONFIRMED" })).toHaveLength(1);
    });
    it("prevents participant double booking even when multiple tables exist", async () => {
      await networkingStore().insert("tables", {
        eventId: ids.event,
        name: "Second table",
        capacity: 2,
      });
      await pair(0, 2);
      // Two requesters, one recipient (a requester holds one pending request per slot).
      const a = await meetings.create(participants[1], {
        profileId: participants[0].profile.id,
        startsAt: slot("10:00"),
      });
      const b = await meetings.create(participants[2], {
        profileId: participants[0].profile.id,
        startsAt: slot("10:00"),
      });
      const results = await Promise.allSettled([
        meetings.respond(participants[0], a.id, { action: "ACCEPT" }),
        meetings.respond(participants[0], b.id, { action: "ACCEPT" }),
      ]);
      expect(results.filter((v) => v.status === "fulfilled")).toHaveLength(1);
    });
    it("preserves the old confirmed reservation when rescheduling fails", async () => {
      await pair(4, 5);
      await pair(0, 4);
      const original = await meetings.create(participants[4], {
        profileId: participants[5].profile.id,
        startsAt: slot("11:00"),
      });
      await meetings.respond(participants[5], original.id, {
        action: "ACCEPT",
      });
      const conflict = await meetings.create(participants[0], {
        profileId: participants[4].profile.id,
        startsAt: slot("11:30"),
      });
      await meetings.respond(participants[4], conflict.id, {
        action: "ACCEPT",
      });
      await meetings.respond(participants[5], original.id, {
        action: "RESCHEDULE",
        startsAt: slot("11:30"),
      });
      await expect(
        meetings.respond(participants[4], original.id, { action: "ACCEPT" }),
      ).rejects.toThrow("already has a meeting");
      const saved = await networkingStore().one("meetings", {
        id: original.id,
        eventId: ids.event,
      });
      expect(saved?.startsAt.toISOString()).toBe(slot("11:00"));
      expect(saved?.status).toBe("CONFIRMED");
      expect(
        await networkingStore().all("reservations", { meetingId: original.id }),
      ).toHaveLength(18);
    });
    it("deduplicates messages and confidential blocking revokes chat and shared bookings", async () => {
      const connection = (await social.connections(participants[0])).items.find(
        (v) => v.profile.id === participants[1].profile.id,
      )!;
      const key = randomUUID();
      const first = await social.sendMessage(
        participants[0],
        connection.id,
        "Hello",
        key,
      );
      expect(
        (await social.sendMessage(participants[0], connection.id, "Hello", key))
          .id,
      ).toBe(first.id);
      await social.block(participants[1], participants[0].profile.id);
      await expect(
        social.sendMessage(
          participants[0],
          connection.id,
          "Blocked",
          randomUUID(),
        ),
      ).rejects.toThrow("not available");
      expect(
        (await social.connections(participants[0])).items.some(
          (v) => v.profile.id === participants[1].profile.id,
        ),
      ).toBe(false);
      expect(
        (
          await networkingStore().all("meetings", {
            eventId: ids.event,
            requesterId: participants[0].profile.id,
            recipientId: participants[1].profile.id,
          })
        ).every((m) => m.status !== "CONFIRMED"),
      ).toBe(true);
    });
    it("requires explicit availability and preserves booked preferences through edits and cancellation", async () => {
      const ctx = participants[5];
      await networkingStore().update(
        "profiles",
        { id: ctx.profile.id, eventId: ids.event },
        { availabilitySet: false },
      );
      expect(
        await meetings.participantSlots(
          { ...ctx, profile: { ...ctx.profile, availabilitySet: false } },
          ctx.profile.id,
        ),
      ).toEqual([]);
      await expect(
        meetings.availableAt(
          ctx,
          ctx.profile.id,
          new Date(slot("13:00")),
          networkingStore(),
        ),
      ).rejects.toThrow("unavailable");
      await networkingStore().update(
        "profiles",
        { id: ctx.profile.id, eventId: ids.event },
        { availabilitySet: true },
      );
      const original = (
        await networkingStore().all("meetings", {
          eventId: ids.event,
          requesterId: participants[4].profile.id,
          recipientId: ctx.profile.id,
        })
      ).find((m) => m.startsAt.toISOString() === slot("11:00"))!;
      const availability = await meetings.availability(ctx);
      expect(availability.slots).toContain(slot("11:00"));
      expect(availability.freeSlots).not.toContain(slot("11:00"));
      await meetings.saveAvailability(ctx, availability.slots);
      await meetings.respond(ctx, original.id, { action: "CANCEL" });
      expect((await meetings.availability(ctx)).freeSlots).toContain(
        slot("11:00"),
      );
    });
    it("routes an exhibitor appointment to the assigned stand even when generic tables are available", async () => {
      const stand = await networkingStore().insert("tables", {
        eventId: ids.event,
        name: "Z exhibition stand",
        kind: "STAND",
        ownerProfileId: participants[5].profile.id,
      });
      await networkingStore().update(
        "profiles",
        { eventId: ids.event, id: participants[5].profile.id },
        { standTableId: stand.id },
      );
      const request = await meetings.create(participants[4], {
        profileId: participants[5].profile.id,
        startsAt: slot("12:00"),
      });
      const confirmed = await meetings.respond(participants[5], request.id, {
        action: "ACCEPT",
      });
      expect(confirmed.tableId).toBe(stand.id);
    });
    it("skips an ineligible earlier profile when duplicate event-email registrations exist", async () => {
      const formId = randomUUID();
      await getDb()
        .insert(forms)
        .values({
          id: formId,
          eventId: ids.event,
          type: "SPONSOR",
          name: "Historical alternate form",
          schema: { steps: [] },
        });
      const registration = await networkingStore().insert("registrations", {
        eventId: ids.event,
        formId,
        email: participants[3].profile.email,
        paymentStatus: "PENDING",
        totalAmount: 0,
        formData: {},
        priceBreakdown: {},
      });
      await networkingStore().insert("profiles", {
        eventId: ids.event,
        registrationId: registration.id,
        email: participants[3].profile.email,
        status: "ACTIVE",
        createdAt: new Date("2000-01-01T00:00Z"),
      });
      const challenge = await service.requestCode(
        ids.event,
        participants[3].profile.email.toUpperCase(),
      );
      const delivery = await networkingStore().one("deliveries", {
        dedupeKey: `otp:${challenge.challengeId}`,
      });
      expect(delivery?.profileId).toBe(participants[3].profile.id);
      const authenticated = await service.verifyCode(
        ids.event,
        challenge.challengeId,
        openNetworkingSecret(String(delivery!.payload.encryptedCode)),
      );
      expect(authenticated.profile.id).toBe(participants[3].profile.id);
    });
    it("revalidates feature flags and session revocation inside mutations", async () => {
      const connection = (await social.connections(participants[4])).items.find(
        (c) => c.profile.id === participants[5].profile.id,
      )!;
      await networkingStore().update(
        "configs",
        { eventId: ids.event },
        { config: { ...config, chatEnabled: false } },
      );
      await expect(
        social.sendMessage(
          participants[4],
          connection.id,
          "Must be rejected",
          randomUUID(),
        ),
      ).rejects.toThrow("Chat is disabled");
      await networkingStore().update(
        "configs",
        { eventId: ids.event },
        { config },
      );
      await networkingStore().update(
        "sessions",
        { id: participants[2].session.id, eventId: ids.event },
        { revokedAt: new Date() },
      );
      await expect(
        social.interest(participants[2], participants[4].profile.id, "LIKE"),
      ).rejects.toThrow("session expired");
    });

    it("prevents overlapping offset intervals even for legacy slots that bypass current config validation", async () => {
      const request = await meetings.create(participants[4], {
        profileId: participants[5].profile.id,
        startsAt: slot("15:00"),
      });
      await meetings.respond(participants[5], request.id, { action: "ACCEPT" });
      const offsetStart = new Date("2031-04-05T15:02:00.000Z"),
        offsetEnd = new Date("2031-04-05T15:32:00.000Z");
      for (const profileId of [
        participants[4].profile.id,
        participants[5].profile.id,
      ])
        await networkingStore().insert("availability", {
          eventId: ids.event,
          profileId,
          startsAt: offsetStart,
        });
      const legacy = await networkingStore().insert("meetings", {
        eventId: ids.event,
        requesterId: participants[4].profile.id,
        recipientId: participants[5].profile.id,
        startsAt: offsetStart,
        endsAt: offsetEnd,
        expiresAt: new Date("2031-04-06T00:00Z"),
      });
      await expect(
        networkingAllocationTransaction(ids.event, [{ startsAt: offsetStart, endsAt: offsetEnd }], (store) =>
          meetings.reserve(
            participants[4],
            legacy,
            offsetStart,
            offsetEnd,
            store,
          ),
        ),
      ).rejects.toThrow("already has a meeting");
      expect(
        await networkingStore().all("reservations", {
          eventId: ids.event,
          meetingId: legacy.id,
        }),
      ).toHaveLength(0);
    });

    it("paginates every message when many messages share one timestamp", async () => {
      const connection = (await social.connections(participants[4])).items.find(
        (c) => c.profile.id === participants[5].profile.id,
      )!;
      const timestamp = new Date("2029-01-01T10:00:00.000Z");
      const expected: string[] = [];
      for (let index = 0; index < 7; index++) {
        const row = await networkingStore().insert("messages", {
          eventId: ids.event,
          connectionId: connection.id,
          senderId: participants[4].profile.id,
          clientMessageId: randomUUID(),
          body: `Same millisecond ${index}`,
          createdAt: timestamp,
        });
        expected.push(row.id);
      }
      const seen: string[] = [];
      let cursor: { before: string; beforeId: string } | null = null;
      do {
        const result = await social.messages(participants[4], connection.id, {
          limit: 2,
          ...(cursor ?? {}),
        });
        seen.push(...result.items.map((item) => item.id));
        cursor = result.nextCursor;
      } while (cursor);
      expect(new Set(seen).size).toBe(seen.length);
      expect(new Set(seen)).toEqual(new Set(expected));
    });

    it("exports participant engagement columns and both companies for matches", async () => {
      await networkingStore().update(
        "profiles",
        { id: participants[4].profile.id, eventId: ids.event },
        { company: "Export Company A" },
      );
      await networkingStore().update(
        "profiles",
        { id: participants[5].profile.id, eventId: ids.event },
        { company: "Export Company B" },
      );
      const exports = new NetworkingExportsService(admin, social, meetings);
      const participantsFile = await exports.admin(
        event,
        "participants",
        "csv",
      );
      expect(String(participantsFile.body)).toContain(
        '"Swipes","Matches","Messages","Planned meetings"',
      );
      const matchesFile = await exports.admin(event, "matches", "csv");
      expect(String(matchesFile.body)).toContain('"Company A"');
      expect(String(matchesFile.body)).toContain('"Company B"');
      expect(String(matchesFile.body)).toContain('"Export Company A"');
      expect(String(matchesFile.body)).toContain('"Export Company B"');
    });
    it("filters organizer meetings by either participant company before pagination", async () => {
      const all = await admin.listMeetings(ids.event, { q: "export company" });
      expect(all.total).toBeGreaterThan(0);
      expect(all.items.every(row => [row.requesterId, row.recipientId].some(id => [participants[4].profile.id, participants[5].profile.id].includes(id)))).toBe(true);
      const page = await admin.listMeetings(ids.event, { q: "EXPORT COMPANY", limit: 1, page: 1 });
      expect(page.total).toBe(all.total);
      expect(page.items).toHaveLength(1);
      expect((await admin.listMeetings(ids.event, { q: "No participant with this company" })).total).toBe(0);
    });
    it("revokes public event access when a required client module is disabled", async () => {
      for (const missing of ["registrations", "emails", "networking"]) {
        await updateClientRow(ids.client, { enabledModules: ["networking", "registrations", "emails"].filter(module => module !== missing) });
        try {
          await expect(service.publicContext(event.slug)).rejects.toThrow();
        } finally {
          await updateClientRow(ids.client, { enabledModules: ["networking", "registrations", "emails"] });
        }
      }
    });
    it("keeps ROI ownership tied to the session profile and rejects blank explicit professional updates", async () => {
      const ctx = participants[4];
      const result = await service.personalAnalytics({ ...ctx, profile: { ...ctx.profile, email: "forged@example.test" } });
      expect(result.events.some(row => row.eventId === ctx.event.id)).toBe(true);
      await expect(service.personalAnalytics({ ...ctx, profile: participants[5].profile })).rejects.toThrow();
      for (const field of ["company", "jobTitle", "sector"]) {
        await expect(service.updateMe(ctx, { [field]: "   " })).rejects.toThrow(`${field} is required`);
      }
    });
  },
);
