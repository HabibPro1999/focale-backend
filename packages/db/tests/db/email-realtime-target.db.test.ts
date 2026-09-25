import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { getDb, emailLogs, getEmailLogRealtimeTarget, getEmailLogRealtimeTargets } from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent, seedRegistration, seedAbstract } from "../helpers/factories";

// N3: real-DB coverage for getEmailLogRealtimeTarget's resolution logic — the
// registration relation and the abstract → event relation each need an actual
// multi-table join, which a hand-rolled drizzle-builder mock can't credibly fake.
describe.runIf(dbTestsEnabled())("db tier: getEmailLogRealtimeTarget (N3)", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it("resolves clientId/eventId via the registration relation", async () => {
    const event = await seedEvent();
    const registration = await seedRegistration({ eventId: event.id });
    const [log] = await getDb()
      .insert(emailLogs)
      .values({
        registrationId: registration.id,
        recipientEmail: "a@x.com",
        subject: "s",
      })
      .returning();

    const target = await getEmailLogRealtimeTarget(log.id);
    expect(target).toEqual({
      clientId: event.clientId,
      eventId: event.id,
      registrationId: registration.id,
    });
  });

  it("resolves clientId/eventId via the abstract → event relation", async () => {
    const event = await seedEvent();
    const abstract = await seedAbstract({ eventId: event.id });
    const [log] = await getDb()
      .insert(emailLogs)
      .values({
        abstractId: abstract.id,
        recipientEmail: "a@x.com",
        subject: "s",
      })
      .returning();

    const target = await getEmailLogRealtimeTarget(log.id);
    expect(target).toEqual({
      clientId: event.clientId,
      eventId: event.id,
      registrationId: null,
    });
  });

  it("returns null for a log linked to neither a registration nor an abstract", async () => {
    const [log] = await getDb()
      .insert(emailLogs)
      .values({ recipientEmail: "a@x.com", subject: "s" })
      .returning();

    await expect(getEmailLogRealtimeTarget(log.id)).resolves.toBeNull();
  });

  it("returns null for an unknown emailLogId", async () => {
    await expect(getEmailLogRealtimeTarget("nope")).resolves.toBeNull();
  });

  it("prefers the registration relation when both registrationId and abstractId are set", async () => {
    const regEvent = await seedEvent();
    const registration = await seedRegistration({ eventId: regEvent.id });
    const absEvent = await seedEvent();
    const abstract = await seedAbstract({ eventId: absEvent.id });
    const [log] = await getDb()
      .insert(emailLogs)
      .values({
        registrationId: registration.id,
        abstractId: abstract.id,
        recipientEmail: "a@x.com",
        subject: "s",
      })
      .returning();

    const target = await getEmailLogRealtimeTarget(log.id);
    expect(target?.eventId).toBe(regEvent.id);
    expect(target?.registrationId).toBe(registration.id);
  });

  it("resolves many logs in one query with the same rules (3.5 coalesced events)", async () => {
    const regEvent = await seedEvent();
    const registration = await seedRegistration({ eventId: regEvent.id });
    const absEvent = await seedEvent();
    const abstract = await seedAbstract({ eventId: absEvent.id });
    const insert = async (values: { registrationId?: string; abstractId?: string }) => {
      const [log] = await getDb()
        .insert(emailLogs)
        .values({ ...values, recipientEmail: "a@x.com", subject: "s" })
        .returning();
      return log.id;
    };
    const viaRegistration = await insert({ registrationId: registration.id });
    const viaAbstract = await insert({ abstractId: abstract.id });
    const both = await insert({ registrationId: registration.id, abstractId: abstract.id });
    const neither = await insert({});

    const targets = await getEmailLogRealtimeTargets([viaRegistration, viaAbstract, both, neither, "nope"]);
    expect(Object.fromEntries(targets)).toEqual({
      [viaRegistration]: { clientId: regEvent.clientId, eventId: regEvent.id, registrationId: registration.id },
      [viaAbstract]: { clientId: absEvent.clientId, eventId: absEvent.id, registrationId: null },
      [both]: { clientId: regEvent.clientId, eventId: regEvent.id, registrationId: registration.id },
    });
    for (const id of [viaRegistration, viaAbstract, both, neither]) {
      expect(targets.get(id) ?? null).toEqual(await getEmailLogRealtimeTarget(id));
    }
    await expect(getEmailLogRealtimeTargets([])).resolves.toEqual(new Map());
  });
});
