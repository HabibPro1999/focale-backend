// Regression coverage for the networking document alignment fixes.
// Uses only the fresh local audit database; no external providers are invoked.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  withSerializableTxn,
  clients,
  forms,
  getDb,
  networkingStore,
  syncNetworkingRegistration,
  networkingDeliveryContext,
  listNetworkingNotifications,
  recordNetworkingProfileView,
  maintainNetworkingLifecycle,
  isNetworkingAccessAllowed,
  getEligibleRegistrationIds,
  networkingEmailMetrics,
} from "@app/db";
import { NetworkingConfigSchema } from "@app/contracts";
import {
  NetworkingService,
  type NetworkingContext,
} from "./networking.service";
import { NetworkingSocialService } from "./networking.social.service";
import { NetworkingMeetingsService } from "./networking.meetings.service";
import { NetworkingAdminService } from "./networking.admin.service";
import { networkingDeliverySkipReason } from "../../../../../packages/integrations/src/networking/delivery-policy";
import { renderNetworkingNotification } from "../../../../../packages/integrations/src/networking/notification-rendering";
import { dbTestsEnabled } from "@app/db/testing";

const service = new NetworkingService();
const social = new NetworkingSocialService(service);
const meetings = new NetworkingMeetingsService(service);
const admin = new NetworkingAdminService(service, meetings);
const store = () => networkingStore(getDb());
let people: NetworkingContext[];
let connectionId: string;
const slot = "2031-04-05T10:00:00.000Z";
const enabled = dbTestsEnabled();

describe.runIf(enabled)("PDF alignment audit reproductions", () => {
  it("returns numeric zero email counts on the database wire protocol", async () => {
    expect(await networkingEmailMetrics(people[0].event.id)).toEqual({
      emailSent: 0, emailDelivered: 0, emailOpened: 0, emailClicked: 0, emailFailed: 0,
    });
  });
  it("rejects meeting windows outside the event without saving them", async () => {
    const { event } = people[0];
    for (const date of ["2031-04-04", "2031-04-06"])
      await expect(admin.config(event.id, {
        openingHours: [{ date, start: "09:00", end: "10:00" }],
      })).rejects.toThrow("within the event dates");
    expect((await admin.config(event.id)).openingHours).toEqual([
      { date: "2031-04-05", start: "09:00", end: "17:00" },
    ]);
  });
  beforeAll(() => {
    process.env.NETWORKING_TOKEN_SECRET =
      "audit-only-secret-at-least-thirty-two-characters";
    process.env.PUBLIC_NETWORKING_URL = "https://networking.example.invalid";
  });
  beforeEach(async () => {
    const clientId = randomUUID();
    await getDb()
      .insert(clients)
      .values({
        id: clientId,
        name: "PDF audit fixture",
        enabledModules: ["networking", "registrations", "emails"],
      });
    const event = await store().insert("events", {
      clientId,
      name: "PDF audit",
      slug: randomUUID(),
      status: "OPEN",
      startDate: new Date("2031-04-05"),
      endDate: new Date("2031-04-06"),
    });
    const config = NetworkingConfigSchema.parse({
      enabled: true,
      approvalMode: "AUTOMATIC",
      timezone: "UTC",
      defaultLanguage: "en",
      openingHours: [{ date: "2031-04-05", start: "09:00", end: "17:00" }],
      fieldMapping: { company: "company" },
    });
    await store().insert("configs", { eventId: event.id, config });
    const formId = randomUUID();
    await getDb()
      .insert(forms)
      .values({
        id: formId,
        eventId: event.id,
        name: "Audit registration",
        schema: {
          steps: [
            {
              id: "details",
              fields: [{ id: "company", type: "text", label: "Company" }],
            },
          ],
        } as never,
      });
    people = [];
    for (let i = 0; i < 3; i++) {
      const registration = await store().insert("registrations", {
        eventId: event.id,
        formId,
        email: `${randomUUID()}@example.invalid`,
        firstName: `Audit ${i}`,
        lastName: "Person",
        paymentStatus: "PAID",
        networkingOptIn: true,
        totalAmount: 0,
        priceBreakdown: {},
        formData: { company: "Original company" },
      });
      await withSerializableTxn((tx) => syncNetworkingRegistration(registration.id, tx));
      const p = (await store().one("profiles", {
        registrationId: registration.id,
      }))!;
      const [profile] = await store().update(
        "profiles",
        { id: p.id, eventId: event.id },
        {
          company: "Original company",
          jobTitle: "Director",
          sector: "Technology",
          availabilitySet: true,
        },
      );
      await store().insert("availability", {
        eventId: event.id,
        profileId: profile.id,
        startsAt: new Date(slot),
      });
      const session = await store().insert("sessions", {
        eventId: event.id,
        profileId: profile.id,
        tokenHash: randomUUID(),
        expiresAt: event.endDate,
      });
      people.push({ event, config, profile, session });
    }
    await store().insert("tables", {
      eventId: event.id,
      name: "Audit table",
      capacity: 2,
    });
    await social.interest(people[0], people[1].profile.id, "LIKE");
    const result = await social.interest(
      people[1],
      people[0].profile.id,
      "LIKE",
    );
    connectionId = result.connectionId!;
  });
  async function booked() {
    const proposal = await meetings.create(people[0], {
      profileId: people[1].profile.id,
      startsAt: slot,
      message: "Original meeting purpose",
    });
    return meetings.respond(people[1], proposal.id, { action: "ACCEPT" });
  }

  it("A1: a moderation exclusion survives registration synchronization", async () => {
    const p = people[1];
    await admin.updateProfile(
      p.event.id,
      p.profile.id,
      { status: "ACTIVE" },
      "audit-organizer",
    );
    const report = await social.report(people[0], {
      profileId: p.profile.id,
      reason: "Synthetic moderation report",
    });
    await admin.moderate(
      p.event.id,
      report.id,
      { action: "EXCLUDE" },
      "audit-organizer",
    );
    expect((await store().one("profiles", { id: p.profile.id }))?.status).toBe(
      "EXCLUDED",
    );
    await store().update(
      "profiles",
      { id: p.profile.id },
      { overrides: { status: "ACTIVE", visible: true } },
    );
    await withSerializableTxn((tx) => syncNetworkingRegistration(p.profile.registrationId, tx));
    expect((await store().one("profiles", { id: p.profile.id }))?.status).toBe(
      "EXCLUDED",
    );
  });

  it("A2: the eligible partner receives an automatic cancellation notice after withdrawal", async () => {
    const meeting = await booked();
    await service.updateMe(people[1], { consent: false });
    const delivery = (
      await store().all("deliveries", {
        eventId: people[0].event.id,
        profileId: people[0].profile.id,
        type: "MEETING_CANCELLED",
      })
    ).find((row) => row.payload.meetingId === meeting.id)!;
    const context = await networkingDeliveryContext(delivery);
    expect(context.meeting?.status).toBe("CANCELLED");
    expect(networkingDeliverySkipReason(delivery, context)).toBeUndefined();
  });

  it("A3: blocked users cannot retrieve each other's updated profiles through meeting history", async () => {
    const meeting = await booked();
    await social.block(people[0], people[1].profile.id);
    await service.updateMe(people[0], {
      bio: "Private update made after blocking",
    });
    await expect(
      service.target(people[1], people[0].profile.id),
    ).rejects.toThrow();
    const history = await meetings.list(people[1]);
    const retained = history.items.find((row) => row.id === meeting.id);
    expect(retained?.requester?.bio).not.toBe(
      "Private update made after blocking",
    );
  });

  it("A4: profiles missing mandatory professional fields are not published in discovery", async () => {
    await store().update(
      "profiles",
      { id: people[1].profile.id },
      { company: "", jobTitle: "", sector: "" },
    );
    const discovered = await service.discover(people[0]);
    expect(
      discovered.items.some((row) => row.id === people[1].profile.id),
    ).toBe(false);
  });

  it("A5: accepting a manually allocated meeting does not announce final confirmation", async () => {
    await store().update(
      "configs",
      { eventId: people[0].event.id },
      { config: { ...people[0].config, autoAssignTables: false } },
    );
    const meeting = await booked();
    expect(meeting.status).toBe("PENDING_ALLOCATION");
    const delivery = (
      await store().all("deliveries", {
        eventId: people[0].event.id,
        profileId: people[0].profile.id,
        type: "MEETING_ACCEPT",
      })
    ).find((row) => row.payload.meetingId === meeting.id)!;
    const rendered = renderNetworkingNotification(
      delivery.type,
      delivery.payload,
      await networkingDeliveryContext(delivery),
    );
    expect(rendered.title.toLowerCase()).not.toContain("confirmed");
  });

  it("A6: reading a conversation clears the corresponding unread-message notification", async () => {
    const sent = await social.sendMessage(
      people[1],
      connectionId,
      "Synthetic unread message",
      randomUUID(),
    );
    const pendingNotifications = await listNetworkingNotifications(
      people[0].event.id,
      people[0].profile.id,
      1,
      100,
    );
    const messageNotification = pendingNotifications.items.find(
      (row) => row.type === "MESSAGE" && !row.readAt &&
        row.data?.connectionId === connectionId,
    );
    const latestCreatedAt = Math.max(
      sent.createdAt.getTime(),
      messageNotification?.createdAt.getTime() ?? 0,
    );
    const timestampDeadline = Date.now() + 1_000;
    while (Date.now() <= latestCreatedAt + 5) {
      if (Date.now() > timestampDeadline)
        throw new Error("Database clock did not advance past the message timestamp");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await social.markRead(people[0], connectionId);
    expect((await social.connections(people[0])).items[0].unreadCount).toBe(0);
    const notifications = await listNetworkingNotifications(
      people[0].event.id,
      people[0].profile.id,
      1,
      100,
    );
    expect(
      notifications.items.filter(
        (row) => row.type === "MESSAGE" && !row.readAt,
      ),
    ).toHaveLength(0);
  });

  it("A7: an organizer removing a source mapping removes its stale projected value", async () => {
    await store().update(
      "configs",
      { eventId: people[0].event.id },
      { config: { ...people[0].config, fieldMapping: {} } },
    );
    await withSerializableTxn((tx) => syncNetworkingRegistration(people[1].profile.registrationId, tx));
    expect(
      (await store().one("profiles", { id: people[1].profile.id }))?.company,
    ).toBe("");
  });

  it("A8: saving an unrelated bio edit does not freeze an unchanged registration company", async () => {
    // ProfileEditor currently submits every professional field, including unchanged ones.
    await service.updateMe(people[1], {
      company: "Original company",
      jobTitle: "Director",
      sector: "Technology",
      bio: "Edited bio",
    });
    await store().update(
      "registrations",
      { id: people[1].profile.registrationId },
      { formData: { company: "Updated registration company" } },
    );
    await withSerializableTxn((tx) => syncNetworkingRegistration(people[1].profile.registrationId, tx));
    expect(
      (await store().one("profiles", { id: people[1].profile.id }))?.company,
    ).toBe("Updated registration company");
  });

  it("A9: the cancellation explanation is preserved for the other participant", async () => {
    const meeting = await booked();
    const cancelled = await meetings.respond(people[0], meeting.id, {
      action: "CANCEL",
      message: "Unable to attend; please contact me later",
    });
    expect(cancelled.cancellationNote).toContain("Unable to attend");
    expect(cancelled.message).toBe("Original meeting purpose");
  });
  it("A10: polling the same profile view does not inflate analytics", async () => {
    const [viewer, peer] = people;
    const viewId = randomUUID();
    await recordNetworkingProfileView(
      viewer.event.id,
      viewer.profile.id,
      peer.profile.id,
      viewId,
    );
    await recordNetworkingProfileView(
      viewer.event.id,
      viewer.profile.id,
      peer.profile.id,
      viewId,
    );
    await recordNetworkingProfileView(
      viewer.event.id,
      viewer.profile.id,
      peer.profile.id,
      randomUUID(),
    );
    expect(
      await store().all("audit", {
        eventId: viewer.event.id,
        action: "PROFILE_VIEW",
      }),
    ).toHaveLength(2);
  });

  it("A14: pending requests hold inventory, not participant time, and decline releases the hold", async () => {
    const proposal = await meetings.create(people[0], {
      profileId: people[1].profile.id,
      startsAt: slot,
    });
    const held = await store().all("reservations", {
      eventId: proposal.eventId,
      meetingId: proposal.id,
    });
    expect(proposal.status).toBe("PENDING");
    expect(proposal.tableId).toBeTruthy();
    expect(held.length).toBeGreaterThan(0);
    // Its table and the requester's one pending-request slot (4.7), never the participants.
    expect(new Set(held.map((row) => row.resourceKey))).toEqual(
      new Set([`table:${proposal.tableId}`, `hold:profile:${people[0].profile.id}`]),
    );
    await social.interest(people[2], people[1].profile.id, "LIKE");
    await social.interest(people[1], people[2].profile.id, "LIKE");
    await expect(
      meetings.create(people[2], {
        profileId: people[1].profile.id,
        startsAt: slot,
      }),
    ).rejects.toThrow("No table");
    await meetings.respond(people[1], proposal.id, { action: "DECLINE" });
    expect(
      await store().all("reservations", { meetingId: proposal.id }),
    ).toHaveLength(0);
    const next = await meetings.create(people[2], {
      profileId: people[1].profile.id,
      startsAt: slot,
    });
    expect(next.tableId).toBe(proposal.tableId);
    const accepted = await meetings.respond(people[1], next.id, {
      action: "ACCEPT",
    });
    expect(accepted.status).toBe("CONFIRMED");
    expect(accepted.tableId).toBe(next.tableId);
  });

  it("A14: expiry releases a pending hold in the background maintenance path", async () => {
    const proposal = await meetings.create(people[0], {
      profileId: people[1].profile.id,
      startsAt: slot,
    });
    await store().update(
      "meetings",
      { id: proposal.id },
      { expiresAt: new Date(Date.now() - 1000) },
    );
    await maintainNetworkingLifecycle(proposal.eventId);
    expect((await store().one("meetings", { id: proposal.id }))?.status).toBe(
      "EXPIRED",
    );
    expect(
      await store().all("reservations", { meetingId: proposal.id }),
    ).toHaveLength(0);
  });

  it("A17: reports and contact exports are queued after the 24-hour grace window, once", async () => {
    const eventId = people[0].event.id;
    await store().update(
      "events",
      { id: eventId },
      { endDate: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    );
    await maintainNetworkingLifecycle(eventId);
    await maintainNetworkingLifecycle(eventId);
    expect(
      await store().all("deliveries", { eventId, type: "POST_EVENT_REPORT" }),
    ).toHaveLength(1);
    expect(
      await store().all("deliveries", { eventId, type: "POST_EVENT_CONTACTS" }),
    ).toHaveLength(people.length);
  });

  it("A19: live scanner and offline preload enforce a confirmed meeting only for the networking entrance", async () => {
    const [person] = people;
    const accessId = randomUUID();
    await store().update(
      "configs",
      { eventId: person.event.id },
      { config: { ...person.config, requiredAccessId: accessId } },
    );
    await store().update(
      "registrations",
      { id: person.profile.registrationId },
      { accessTypeIds: [accessId] },
    );
    expect(
      await isNetworkingAccessAllowed(
        person.event.id,
        person.profile.registrationId,
        accessId,
      ),
    ).toBe(false);
    expect(
      await getEligibleRegistrationIds(person.event.id, accessId),
    ).not.toContain(person.profile.registrationId);
    expect(
      await isNetworkingAccessAllowed(
        person.event.id,
        person.profile.registrationId,
        randomUUID(),
      ),
    ).toBe(true);
    const meeting = await booked();
    expect(
      await isNetworkingAccessAllowed(
        person.event.id,
        person.profile.registrationId,
        accessId,
      ),
    ).toBe(true);
    expect(
      await getEligibleRegistrationIds(person.event.id, accessId),
    ).toContain(person.profile.registrationId);
    expect(
      await service.badgeProfileId(
        person.event.id,
        person.profile.registrationId,
      ),
    ).toBe(person.profile.id);
    await expect(
      service.badgeProfileId(randomUUID(), person.profile.registrationId),
    ).rejects.toThrow();
    await meetings.respond(person, meeting.id, { action: "CANCEL" });
    expect(
      await isNetworkingAccessAllowed(
        person.event.id,
        person.profile.registrationId,
        accessId,
      ),
    ).toBe(false);
  });
  it("A11: default meeting notices include professional identity, the full time range and access/support details", async () => {
    const eventId = people[0].event.id;
    await store().update(
      "configs",
      { eventId },
      {
        config: {
          ...people[0].config,
          accessInstructions: "Use the north entrance",
          accessPlanUrl: "https://example.invalid/plan",
          supportPhone: "+216 12345678",
          supportEmail: "help@example.invalid",
        },
      },
    );
    const meeting = await booked();
    const delivery = (
      await store().all("deliveries", {
        eventId,
        profileId: people[0].profile.id,
        type: "MEETING_ACCEPT",
      })
    ).find((row) => row.payload.meetingId === meeting.id)!;
    const rendered = renderNetworkingNotification(
      delivery.type,
      delivery.payload,
      await networkingDeliveryContext(delivery),
    );
    for (const value of [
      "Original company",
      "Director",
      "10:00",
      "10:30",
      "Use the north entrance",
      "+216 12345678",
      "help@example.invalid",
    ])
      expect(rendered.body).toContain(value);
    expect(rendered.html).toContain('href="https://example.invalid/plan"');
  });

  it("A4: a participant can discard an override and resume following registration updates", async () => {
    const person = people[0];
    await service.updateMe(person, { company: "Personal override" });
    await store().update(
      "registrations",
      { id: person.profile.registrationId },
      { formData: { company: "New source company" } },
    );
    const reset = await service.updateMe(person, { resetFields: ["company"] });
    expect(reset.company).toBe("New source company");
    expect(reset.overrides).not.toHaveProperty("company");
  });
});
