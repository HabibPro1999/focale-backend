import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAbstractsForBulkEmail } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { cleanupDatabase } from "../helpers/cleanup";
import {
  linkAbstractTheme,
  seedAbstract,
  seedAbstractConfig,
  seedAbstractTheme,
  seedClient,
  seedEvent,
} from "../helpers/factories";

// Recipients of a bulk send to abstract authors (backend 0f86c91d,
// listAbstractsForBulkEmail): ids or filters, oldest first, per-author dedupe
// on the normalized email, blank emails skipped. Each abstract gets its own
// created_at so "oldest" never rides a tie.
const at = (minute: number) => new Date(Date.UTC(2030, 0, 1, 9, minute));

describe.runIf(dbTestsEnabled())("db tier: abstract bulk-email recipients", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  async function eventWithConfig() {
    const client = await seedClient({ name: "Client", email: "contact@client.tn", phone: "+216" });
    const event = await seedEvent({ clientId: client.id, name: "Congress", location: "Tunis" });
    const config = await seedAbstractConfig({
      eventId: event.id,
      editingDeadline: new Date("2030-01-15T12:00:00Z"),
      finalFileUploadEnabled: true,
      languages: ["en", "fr"],
    });
    return { client, event, config };
  }

  it("dedupes by normalized author email, keeping the oldest abstract", async () => {
    const { event } = await eventWithConfig();
    const first = await seedAbstract({
      eventId: event.id,
      authorEmail: "ada@example.com",
      authorEmailNormalized: "ada@example.com",
      createdAt: at(1),
    });
    // A legacy row without the normalized column: its lower-cased, trimmed email is the key.
    await seedAbstract({
      eventId: event.id,
      authorEmail: " ADA@example.com ",
      authorEmailNormalized: null,
      createdAt: at(2),
    });
    const other = await seedAbstract({
      eventId: event.id,
      authorEmail: "alan@example.com",
      createdAt: at(3),
    });

    const result = await listAbstractsForBulkEmail(event.id);

    expect(result.recipients.map((r) => r.id)).toEqual([first.id, other.id]);
    expect(result.skipped).toBe(1);
  });

  it("keeps duplicates when dedupeByEmail is off and skips blank emails", async () => {
    const { event } = await eventWithConfig();
    const a = await seedAbstract({ eventId: event.id, authorEmail: "ada@example.com", createdAt: at(1) });
    const b = await seedAbstract({ eventId: event.id, authorEmail: "Ada@Example.com", createdAt: at(2) });
    await seedAbstract({ eventId: event.id, authorEmail: "   ", createdAt: at(3) });

    const result = await listAbstractsForBulkEmail(event.id, { dedupeByEmail: false });

    expect(result.recipients.map((r) => r.id)).toEqual([a.id, b.id]);
    expect(result.skipped).toBe(1);
  });

  it("holds explicit ids to the event and ignores the filters", async () => {
    const { event, config } = await eventWithConfig();
    const theme = await seedAbstractTheme({ configId: config.id });
    const accepted = await seedAbstract({ eventId: event.id, status: "ACCEPTED", createdAt: at(1) });
    await seedAbstract({ eventId: event.id, status: "ACCEPTED", createdAt: at(2) });
    const elsewhere = await seedAbstract({ eventId: (await seedEvent()).id, createdAt: at(3) });

    const result = await listAbstractsForBulkEmail(event.id, {
      abstractIds: [accepted.id, elsewhere.id],
      filters: { status: ["REJECTED"], themeId: theme.id },
    });

    expect(result.recipients.map((r) => r.id)).toEqual([accepted.id]);
    expect(result.skipped).toBe(0);
  });

  it("applies the status list, theme and effective presentation type", async () => {
    const { event, config } = await eventWithConfig();
    const theme = await seedAbstractTheme({ configId: config.id });
    const otherTheme = await seedAbstractTheme({ configId: config.id, label: "Other", sortOrder: 1 });
    const seed = async (
      minute: number,
      values: Parameters<typeof seedAbstract>[0],
      themeId = theme.id,
    ) => {
      const row = await seedAbstract({ ...values, createdAt: at(minute) });
      await linkAbstractTheme(row.id, themeId);
      return row;
    };

    const finalPoster = await seed(1, {
      eventId: event.id,
      status: "ACCEPTED",
      requestedType: "ORAL_COMMUNICATION",
      finalType: "POSTER",
    });
    const requestedPoster = await seed(2, {
      eventId: event.id,
      status: "PENDING",
      requestedType: "POSTER",
      finalType: null,
    });
    // Requested a poster, decided as an oral communication: not a poster.
    await seed(3, { eventId: event.id, status: "ACCEPTED", requestedType: "POSTER", finalType: "ORAL_COMMUNICATION" });
    // Status outside the list.
    await seed(4, { eventId: event.id, status: "REJECTED", requestedType: "POSTER" });
    // Another theme.
    await seed(5, { eventId: event.id, status: "ACCEPTED", requestedType: "POSTER" }, otherTheme.id);

    const result = await listAbstractsForBulkEmail(event.id, {
      filters: { status: ["ACCEPTED", "PENDING"], themeId: theme.id, presentationType: "POSTER" },
    });

    expect(result.recipients.map((r) => r.id)).toEqual([finalPoster.id, requestedPoster.id]);
  });

  it("with no ids and no filters, lists every abstract of the event only", async () => {
    const { event } = await eventWithConfig();
    const a = await seedAbstract({ eventId: event.id, status: "SUBMITTED", createdAt: at(2) });
    const b = await seedAbstract({ eventId: event.id, status: "REJECTED", createdAt: at(1) });
    await seedAbstract({ eventId: (await seedEvent()).id, createdAt: at(0) });

    const result = await listAbstractsForBulkEmail(event.id, { abstractIds: [], filters: { status: [] } });

    expect(result.recipients.map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it("carries the author, event, organizer and config the email context needs", async () => {
    const { client, event } = await eventWithConfig();
    const row = await seedAbstract({
      eventId: event.id,
      authorFirstName: "Ada",
      authorLastName: "Lovelace",
      authorAffiliation: "Analytical Institute",
      authorEmail: " ada@example.com ",
      authorPhone: "+21612345678",
      content: { title: "Computing" },
      linkBaseUrl: "https://events.example.com",
    });

    const { recipients } = await listAbstractsForBulkEmail(event.id);

    expect(recipients).toEqual([
      expect.objectContaining({
        id: row.id,
        authorFirstName: "Ada",
        authorLastName: "Lovelace",
        authorAffiliation: "Analytical Institute",
        authorEmail: "ada@example.com",
        authorPhone: "+21612345678",
        content: { title: "Computing" },
        status: "SUBMITTED",
        requestedType: "ORAL_COMMUNICATION",
        finalType: null,
        code: null,
        editToken: row.editToken,
        linkBaseUrl: "https://events.example.com",
        eventId: event.id,
        language: "en",
        event: {
          name: "Congress",
          slug: event.slug,
          clientId: client.id,
          startDate: event.startDate,
          endDate: event.endDate,
          location: "Tunis",
          client: { name: "Client", email: "contact@client.tn", phone: "+216" },
        },
        config: expect.objectContaining({
          editingDeadline: new Date("2030-01-15T12:00:00Z"),
          submissionDeadline: null,
          finalFileUploadEnabled: true,
        }),
      }),
    ]);
  });

  it("falls back to the config defaults when the event has no abstract config", async () => {
    const event = await seedEvent();
    await seedAbstract({ eventId: event.id });

    const { recipients } = await listAbstractsForBulkEmail(event.id);

    expect(recipients[0].language).toBe("fr");
    expect(recipients[0].config).toEqual({
      submissionStartAt: null,
      submissionDeadline: null,
      editingDeadline: null,
      scoringStartAt: null,
      scoringDeadline: null,
      finalFileDeadline: null,
      finalFileUploadEnabled: false,
    });
    expect(recipients[0].event.client.name).toBe("Test Client");
  });

  it("returns nothing for an unknown event", async () => {
    await expect(listAbstractsForBulkEmail("00000000-0000-4000-8000-000000000000")).resolves.toEqual({
      recipients: [],
      skipped: 0,
    });
  });
});
