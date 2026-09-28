import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { newId } from "@app/shared";
import {
  abstractRevisions,
  abstractThemeLinks,
  abstracts,
  editAbstractTxn,
  getDb,
  outboxEvents,
  submitAbstractTxn,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import {
  seedAbstractConfig,
  seedAbstractTheme,
  seedEvent,
  seedRegistration,
} from "../helpers/factories";
import { auditRowsOf } from "../helpers/sponsorship-inspect";

// The public submit and edit writes: every row each one leaves behind (the
// abstract, its revision, theme links, audit row and acknowledgement email
// event), and the duplicate first-author email refusal.

async function seedEventWithThemes() {
  const event = await seedEvent({ status: "OPEN" });
  const config = await seedAbstractConfig({ eventId: event.id });
  const themeA = await seedAbstractTheme({ configId: config.id, sortOrder: 0 });
  const themeB = await seedAbstractTheme({ configId: config.id, sortOrder: 1 });
  return { event, themeA, themeB };
}

function submitParams(eventId: string, email = "amina@example.test") {
  const id = newId();
  return {
    id,
    eventId,
    editToken: newId(),
    authorFirstName: "Amina",
    authorLastName: "Ben Salah",
    authorAffiliation: "Institut Pasteur",
    authorEmail: ` ${email.toUpperCase()} `,
    authorEmailNormalized: email,
    authorPhone: "+21611111111",
    requestedType: "ORAL_COMMUNICATION" as const,
    content: { mode: "FREE_TEXT", title: "First title", body: "<p>One</p>" },
    coAuthors: [{ firstName: "Co", lastName: "Author" }],
    additionalFieldsData: { keywords: "first" },
    linkBaseUrl: "https://forms.example.test",
    registrationId: null as string | null,
    themeIds: [] as string[],
    revisionSnapshot: { revision: "first" },
    ip: "203.0.113.7" as string | undefined,
  };
}

function editParams(id: string, email = "amina@example.test") {
  return {
    id,
    authorFirstName: "Amira",
    authorLastName: "Ben Salem",
    authorAffiliation: "Faculté de médecine",
    authorEmail: email,
    authorEmailNormalized: email,
    authorPhone: "+21622222222",
    requestedType: "POSTER" as const,
    content: { mode: "FREE_TEXT", title: "Edited title", body: "<p>Two</p>" },
    coAuthors: [],
    additionalFieldsData: { keywords: "edited" },
    registrationId: null as string | null,
    themeIds: [] as string[],
    revisionSnapshot: { revision: "edited" },
    lastEditedAt: new Date("2030-01-01T10:00:00.000Z"),
    ip: "198.51.100.9" as string | undefined,
  };
}

async function abstractRow(id: string) {
  const [row] = await getDb().select().from(abstracts).where(eq(abstracts.id, id));
  return row;
}

async function revisionsOf(abstractId: string) {
  return getDb()
    .select()
    .from(abstractRevisions)
    .where(eq(abstractRevisions.abstractId, abstractId))
    .orderBy(asc(abstractRevisions.revisionNo));
}

async function themeIdsOf(abstractId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ themeId: abstractThemeLinks.themeId })
    .from(abstractThemeLinks)
    .where(eq(abstractThemeLinks.abstractId, abstractId));
  return rows.map((row) => row.themeId).sort();
}

async function emailEventsOf(abstractId: string) {
  return getDb()
    .select({
      type: outboxEvents.type,
      aggregateType: outboxEvents.aggregateType,
      dedupeKey: outboxEvents.dedupeKey,
      payload: outboxEvents.payload,
      maxAttempts: outboxEvents.maxAttempts,
    })
    .from(outboxEvents)
    .where(eq(outboxEvents.aggregateId, abstractId))
    .orderBy(asc(outboxEvents.createdAt), asc(outboxEvents.dedupeKey));
}

describe.runIf(dbTestsEnabled())("db tier: public abstract writes", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it("submit writes the abstract, revision 1, links, audit and ack", async () => {
    const { event, themeA, themeB } = await seedEventWithThemes();
    const registration = await seedRegistration({ eventId: event.id });
    const params = {
      ...submitParams(event.id),
      registrationId: registration.id,
      themeIds: [themeB.id, themeA.id],
    };

    const result = await submitAbstractTxn(params);

    const row = await abstractRow(params.id);
    expect(result).toEqual({ ok: true, createdAt: row.createdAt });
    expect(row).toMatchObject({
      eventId: event.id,
      authorFirstName: "Amina",
      authorLastName: "Ben Salah",
      authorAffiliation: "Institut Pasteur",
      authorEmail: " AMINA@EXAMPLE.TEST ",
      authorEmailNormalized: "amina@example.test",
      authorPhone: "+21611111111",
      requestedType: "ORAL_COMMUNICATION",
      content: params.content,
      coAuthors: params.coAuthors,
      additionalFieldsData: params.additionalFieldsData,
      status: "SUBMITTED",
      editToken: params.editToken,
      linkBaseUrl: "https://forms.example.test",
      registrationId: registration.id,
      contentVersion: 1,
      lastEditedAt: null,
    });
    expect(await revisionsOf(params.id)).toMatchObject([
      {
        revisionNo: 1,
        snapshot: { revision: "first" },
        editedBy: "PUBLIC",
        editedIpAddress: "203.0.113.7",
        content: params.content,
        coAuthors: params.coAuthors,
        additionalFieldsData: params.additionalFieldsData,
      },
    ]);
    expect(await themeIdsOf(params.id)).toEqual([themeA.id, themeB.id].sort());
    expect(await auditRowsOf("Abstract", params.id)).toMatchObject([
      {
        action: "submit",
        changes: null,
        performedBy: "PUBLIC",
        ipAddress: "203.0.113.7",
      },
    ]);
    expect(await emailEventsOf(params.id)).toEqual([
      {
        type: "email.abstract",
        aggregateType: "Abstract",
        dedupeKey: `email:abstract:ABSTRACT_SUBMISSION_ACK:${params.id}`,
        payload: { trigger: "ABSTRACT_SUBMISSION_ACK", abstractId: params.id },
        maxAttempts: 5,
      },
    ]);
  });

  it("submit without themes or ip links nothing and records no ip", async () => {
    const { event } = await seedEventWithThemes();
    const params = { ...submitParams(event.id), ip: undefined };

    expect(await submitAbstractTxn(params)).toMatchObject({ ok: true });

    expect(await themeIdsOf(params.id)).toEqual([]);
    expect(await revisionsOf(params.id)).toMatchObject([
      { revisionNo: 1, editedIpAddress: null },
    ]);
    expect(await auditRowsOf("Abstract", params.id)).toMatchObject([
      { action: "submit", ipAddress: null },
    ]);
  });

  it("a second submit with the same author email writes nothing", async () => {
    const { event, themeA } = await seedEventWithThemes();
    const first = submitParams(event.id);
    expect(await submitAbstractTxn(first)).toMatchObject({ ok: true });

    const second = { ...submitParams(event.id), themeIds: [themeA.id] };
    expect(await submitAbstractTxn(second)).toEqual({
      ok: false,
      reason: "duplicate_email",
    });

    expect(await abstractRow(second.id)).toBeUndefined();
    expect(await revisionsOf(second.id)).toEqual([]);
    expect(await themeIdsOf(second.id)).toEqual([]);
    expect(await auditRowsOf("Abstract", second.id)).toEqual([]);
    expect(await emailEventsOf(second.id)).toEqual([]);
  });

  it("edit rewrites the author fields, adds a revision and relinks themes", async () => {
    const { event, themeA, themeB } = await seedEventWithThemes();
    const submitted = { ...submitParams(event.id), themeIds: [themeA.id] };
    await submitAbstractTxn(submitted);
    const registration = await seedRegistration({ eventId: event.id });
    const edit = {
      ...editParams(submitted.id),
      registrationId: registration.id,
      themeIds: [themeB.id],
    };

    expect(await editAbstractTxn(edit)).toEqual({ ok: true });

    expect(await abstractRow(submitted.id)).toMatchObject({
      authorFirstName: "Amira",
      authorLastName: "Ben Salem",
      authorAffiliation: "Faculté de médecine",
      authorEmail: "amina@example.test",
      authorEmailNormalized: "amina@example.test",
      authorPhone: "+21622222222",
      requestedType: "POSTER",
      content: edit.content,
      coAuthors: [],
      additionalFieldsData: { keywords: "edited" },
      registrationId: registration.id,
      lastEditedAt: edit.lastEditedAt,
      contentVersion: 2,
      status: "SUBMITTED",
      editToken: submitted.editToken,
      linkBaseUrl: submitted.linkBaseUrl,
    });
    expect(await revisionsOf(submitted.id)).toMatchObject([
      { revisionNo: 1, snapshot: { revision: "first" } },
      {
        revisionNo: 2,
        snapshot: { revision: "edited" },
        editedBy: "PUBLIC",
        editedIpAddress: "198.51.100.9",
        content: edit.content,
        coAuthors: [],
        additionalFieldsData: { keywords: "edited" },
      },
    ]);
    expect(await themeIdsOf(submitted.id)).toEqual([themeB.id]);
    const audits = await auditRowsOf("Abstract", submitted.id);
    expect(audits.find((row) => row.action === "edit")).toMatchObject({
      changes: null,
      performedBy: "PUBLIC",
      ipAddress: "198.51.100.9",
    });
    expect(await emailEventsOf(submitted.id)).toContainEqual({
      type: "email.abstract",
      aggregateType: "Abstract",
      dedupeKey: `email:abstract:ABSTRACT_EDIT_ACK:${submitted.id}:2`,
      payload: { trigger: "ABSTRACT_EDIT_ACK", abstractId: submitted.id },
      maxAttempts: 5,
    });

    const unlink = { ...editParams(submitted.id), ip: undefined };
    expect(await editAbstractTxn(unlink)).toEqual({ ok: true });

    expect(await themeIdsOf(submitted.id)).toEqual([]);
    expect(await revisionsOf(submitted.id)).toMatchObject([
      { revisionNo: 1 },
      { revisionNo: 2 },
      { revisionNo: 3, editedIpAddress: null },
    ]);
    expect(await abstractRow(submitted.id)).toMatchObject({
      contentVersion: 3,
      registrationId: null,
    });
    expect(
      (await emailEventsOf(submitted.id)).map((row) => row.dedupeKey),
    ).toContain(`email:abstract:ABSTRACT_EDIT_ACK:${submitted.id}:3`);
  });

  it("edit onto another abstract's author email writes nothing", async () => {
    const { event, themeA, themeB } = await seedEventWithThemes();
    const taken = submitParams(event.id, "taken@example.test");
    await submitAbstractTxn(taken);
    const target = {
      ...submitParams(event.id, "target@example.test"),
      themeIds: [themeA.id],
    };
    await submitAbstractTxn(target);
    const before = await abstractRow(target.id);

    const edit = {
      ...editParams(target.id, "taken@example.test"),
      themeIds: [themeB.id],
    };
    expect(await editAbstractTxn(edit)).toEqual({
      ok: false,
      reason: "duplicate_email",
    });

    expect(await abstractRow(target.id)).toEqual(before);
    expect(await revisionsOf(target.id)).toMatchObject([{ revisionNo: 1 }]);
    expect(await themeIdsOf(target.id)).toEqual([themeA.id]);
    expect(
      (await auditRowsOf("Abstract", target.id)).map((row) => row.action),
    ).toEqual(["submit"]);
    expect(
      (await emailEventsOf(target.id)).map((row) => row.dedupeKey),
    ).toEqual([`email:abstract:ABSTRACT_SUBMISSION_ACK:${target.id}`]);
  });
});
