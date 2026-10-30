/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import { AbstractStatus } from "@/generated/prisma/client.js";

vi.mock("@shared/utils/audit.js", () => ({ auditLog: vi.fn() }));

import {
  finalizeAbstract,
  reopenAbstract,
  buildAdminAbstractsWhere,
  listAbstractsForBulkEmail,
} from "./abstracts.admin.service.js";

const eventId = "event-1";
const abstractId = "abstract-1";
const themeId = "theme-1";
const performedBy = "admin-1";

function makeAbstract(overrides: Record<string, unknown> = {}) {
  return {
    id: abstractId,
    eventId,
    authorFirstName: "Ada",
    authorLastName: "Lovelace",
    authorAffiliation: "Analytical Institute",
    authorEmail: "ada@example.com",
    authorPhone: "+21612345678",
    requestedType: "ORAL_COMMUNICATION",
    finalType: null,
    content: { mode: "FREE_TEXT", title: "Computing", body: "Notes" },
    coAuthors: [],
    additionalFieldsData: {},
    code: null,
    codeNumber: null,
    status: AbstractStatus.REVIEW_COMPLETE,
    contentVersion: 1,
    averageScore: 15,
    reviewCount: 2,
    finalFileKey: null,
    finalFileKind: null,
    finalFileSize: null,
    finalFileUploadedAt: null,
    editToken: "token",
    lastEditedAt: null,
    linkBaseUrl: "https://events.example.com",
    registrationId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    themes: [
      { themeId, theme: { id: themeId, label: "Theme A", sortOrder: 1 } },
    ],
    reviews: [],
    revisions: [],
    ...overrides,
  };
}

describe("abstracts admin service", () => {
  it("finalizes accepted abstracts with an event/theme sequence code and queues accepted email", async () => {
    prismaMock.$transaction.mockImplementation(async (callback: any) =>
      callback(prismaMock),
    );
    prismaMock.abstract.findUnique
      .mockResolvedValueOnce(
        makeAbstract({
          event: {
            clientId: "client-1",
            abstractConfig: {
              commentsEnabled: false,
              commentsSentToAuthor: false,
              finalFileUploadEnabled: false,
            },
          },
          reviews: [],
        }) as any,
      )
      .mockResolvedValueOnce(
        makeAbstract({
          status: AbstractStatus.ACCEPTED,
          finalType: "ORAL_COMMUNICATION",
          code: "OC1-01",
          codeNumber: 1,
        }) as any,
      );
    prismaMock.abstract.aggregate.mockResolvedValue({
      _max: { codeNumber: null },
    } as any);
    prismaMock.abstractCodeCounter.findUnique.mockResolvedValue(null);
    prismaMock.abstractCodeCounter.upsert.mockResolvedValue({
      lastValue: 1,
    } as any);
    prismaMock.abstract.update.mockResolvedValue({
      id: abstractId,
      eventId,
      status: AbstractStatus.ACCEPTED,
      finalType: "ORAL_COMMUNICATION",
      code: "OC1-01",
      codeNumber: 1,
      averageScore: 15,
      reviewCount: 2,
    } as any);

    const result = await finalizeAbstract(
      eventId,
      abstractId,
      { decision: "ACCEPTED", finalType: "ORAL_COMMUNICATION" },
      performedBy,
    );

    expect(prismaMock.abstract.aggregate).toHaveBeenCalledWith({
      where: {
        eventId,
        finalType: "ORAL_COMMUNICATION",
        codeNumber: { not: null },
        themes: { some: { themeId } },
      },
      _max: { codeNumber: true },
    });
    expect(prismaMock.abstractCodeCounter.upsert).toHaveBeenCalledWith({
      where: {
        eventId_themeId_finalType: {
          eventId,
          themeId,
          finalType: "ORAL_COMMUNICATION",
        },
      },
      update: { lastValue: { increment: 1 } },
      create: {
        eventId,
        themeId,
        finalType: "ORAL_COMMUNICATION",
        lastValue: 1,
      },
      select: { lastValue: true },
    });
    expect(prismaMock.abstractCodeSequence.update).not.toHaveBeenCalled();
    expect(prismaMock.abstract.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: abstractId }),
        data: expect.objectContaining({
          status: "ACCEPTED",
          finalType: "ORAL_COMMUNICATION",
          code: "OC1-01",
          codeNumber: 1,
        }),
      }),
    );
    expect(prismaMock.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "email.abstract",
          dedupeKey: `email:abstract:ABSTRACT_ACCEPTED:${abstractId}:${new Date("2026-01-02T00:00:00.000Z").getTime()}`,
          payload: { trigger: "ABSTRACT_ACCEPTED", abstractId },
        }),
      }),
    );
    expect(result).toMatchObject({ status: "ACCEPTED", code: "OC1-01" });
  });

  it("requires a reopen before changing an already finalized abstract", async () => {
    prismaMock.$transaction.mockImplementation(async (callback: any) =>
      callback(prismaMock),
    );
    prismaMock.abstract.findUnique.mockResolvedValue(
      makeAbstract({
        status: AbstractStatus.ACCEPTED,
        event: { clientId: "client-1", abstractConfig: null },
        reviews: [],
      }) as any,
    );

    await expect(
      finalizeAbstract(
        eventId,
        abstractId,
        { decision: "REJECTED" },
        performedBy,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(prismaMock.abstract.update).not.toHaveBeenCalled();
  });

  it("reopens finalized abstracts and clears the allocated code number", async () => {
    prismaMock.$transaction.mockImplementation(async (callback: any) =>
      callback(prismaMock),
    );
    prismaMock.abstract.findUnique
      .mockResolvedValueOnce(
        makeAbstract({
          status: AbstractStatus.ACCEPTED,
          finalType: "POSTER",
          code: "001-PO",
          codeNumber: 1,
          event: { clientId: "client-1" },
          reviews: [{ id: "review-1" }],
        }) as any,
      )
      .mockResolvedValueOnce(
        makeAbstract({
          status: AbstractStatus.UNDER_REVIEW,
          finalType: null,
          code: null,
          codeNumber: null,
        }) as any,
      );
    prismaMock.abstract.update.mockResolvedValue({
      id: abstractId,
      status: AbstractStatus.UNDER_REVIEW,
      averageScore: 15,
      reviewCount: 2,
    } as any);

    const result = await reopenAbstract(eventId, abstractId, performedBy);

    expect(prismaMock.abstract.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: abstractId },
        data: {
          status: "UNDER_REVIEW",
          finalType: null,
          code: null,
          codeNumber: null,
        },
      }),
    );
    expect(result.status).toBe("UNDER_REVIEW");
  });
});

describe("buildAdminAbstractsWhere", () => {
  it("matches finalType === type OR (finalType null AND requestedType === type) for POSTER", () => {
    const where = buildAdminAbstractsWhere(eventId, { presentationType: "POSTER" });

    expect(where).toEqual({
      eventId,
      AND: [
        {
          OR: [
            { finalType: "POSTER" },
            { finalType: null, requestedType: "POSTER" },
          ],
        },
      ],
    });
  });

  it("produces two separate AND entries when q and presentationType are combined", () => {
    const where = buildAdminAbstractsWhere(eventId, {
      q: "ada",
      presentationType: "ORAL_COMMUNICATION",
    });

    const and = where.AND as unknown[];
    expect(and).toHaveLength(2);
    expect(and[0]).toEqual({
      OR: [
        { authorFirstName: { contains: "ada" } },
        { authorLastName: { contains: "ada" } },
        { authorAffiliation: { contains: "ada" } },
        { authorEmail: { contains: "ada" } },
        { code: { contains: "ada" } },
      ],
    });
    expect(and[1]).toEqual({
      OR: [
        { finalType: "ORAL_COMMUNICATION" },
        { finalType: null, requestedType: "ORAL_COMMUNICATION" },
      ],
    });
  });

  it("emits no requestedType branch for CONFERENCE", () => {
    const where = buildAdminAbstractsWhere(eventId, {
      presentationType: "CONFERENCE",
    });

    expect(where).toEqual({
      eventId,
      AND: [{ OR: [{ finalType: "CONFERENCE" }] }],
    });
  });

  it("leaves the where clause unchanged when no presentationType or q is passed", () => {
    const where = buildAdminAbstractsWhere(eventId, { status: "ACCEPTED" });

    expect(where).toEqual({
      eventId,
      status: "ACCEPTED",
    });
    expect(where.AND).toBeUndefined();
  });
});

describe("listAbstractsForBulkEmail", () => {
  function makeRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "abstract-1",
      authorFirstName: "Ada",
      authorLastName: "Lovelace",
      authorAffiliation: "Analytical Institute",
      authorEmail: "ada@example.com",
      authorEmailNormalized: "ada@example.com",
      authorPhone: "+21612345678",
      content: { mode: "FREE_TEXT", title: "Computing" },
      status: AbstractStatus.ACCEPTED,
      requestedType: "ORAL_COMMUNICATION",
      finalType: null,
      code: null,
      editToken: "token-1",
      linkBaseUrl: "https://events.example.com",
      ...overrides,
    };
  }

  const event = {
    name: "Congress",
    slug: "congress",
    startDate: new Date("2026-04-20T00:00:00.000Z"),
    endDate: new Date("2026-04-22T00:00:00.000Z"),
    location: "Tunis",
    client: { name: "Client", email: "contact@client.tn", phone: "+216" },
    abstractConfig: null,
  };

  it("dedupes by normalized author email keeping the oldest abstract", async () => {
    prismaMock.abstract.findMany.mockResolvedValue([
      makeRow({ id: "abstract-1" }),
      makeRow({ id: "abstract-2" }),
      makeRow({
        id: "abstract-3",
        authorEmail: "alan@example.com",
        authorEmailNormalized: "alan@example.com",
      }),
    ] as any);
    prismaMock.event.findUnique.mockResolvedValue(event as any);

    const result = await listAbstractsForBulkEmail(eventId);

    expect(result.recipients.map((r) => r.id)).toEqual([
      "abstract-1",
      "abstract-3",
    ]);
    expect(result.skipped).toBe(1);
    expect(prismaMock.abstract.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { eventId },
        orderBy: { createdAt: "asc" },
      }),
    );
  });

  it("keeps duplicates when dedupeByEmail is disabled and skips blank emails", async () => {
    prismaMock.abstract.findMany.mockResolvedValue([
      makeRow({ id: "abstract-1" }),
      makeRow({ id: "abstract-2" }),
      makeRow({
        id: "abstract-3",
        authorEmail: "   ",
        authorEmailNormalized: null,
      }),
    ] as any);
    prismaMock.event.findUnique.mockResolvedValue(event as any);

    const result = await listAbstractsForBulkEmail(eventId, {
      dedupeByEmail: false,
    });

    expect(result.recipients.map((r) => r.id)).toEqual([
      "abstract-1",
      "abstract-2",
    ]);
    expect(result.skipped).toBe(1);
  });

  it("constrains explicit abstract ids to the event and ignores filters", async () => {
    prismaMock.abstract.findMany.mockResolvedValue([] as any);
    prismaMock.event.findUnique.mockResolvedValue(event as any);

    await listAbstractsForBulkEmail(eventId, {
      abstractIds: ["abstract-9"],
      filters: { status: [AbstractStatus.REJECTED], themeId },
    });

    expect(prismaMock.abstract.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { eventId, id: { in: ["abstract-9"] } },
      }),
    );
  });

  it("applies status, theme and presentation type filters", async () => {
    prismaMock.abstract.findMany.mockResolvedValue([] as any);
    prismaMock.event.findUnique.mockResolvedValue(event as any);

    await listAbstractsForBulkEmail(eventId, {
      filters: {
        status: [AbstractStatus.ACCEPTED, AbstractStatus.PENDING],
        themeId,
        presentationType: "POSTER",
      },
    });

    expect(prismaMock.abstract.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          eventId,
          themes: { some: { themeId } },
          status: { in: [AbstractStatus.ACCEPTED, AbstractStatus.PENDING] },
          AND: [
            {
              OR: [
                { finalType: "POSTER" },
                { finalType: null, requestedType: "POSTER" },
              ],
            },
          ],
        },
      }),
    );
  });

  it("falls back to the event config defaults and exposes base variables", async () => {
    prismaMock.abstract.findMany.mockResolvedValue([makeRow()] as any);
    prismaMock.event.findUnique.mockResolvedValue(event as any);

    const { recipients } = await listAbstractsForBulkEmail(eventId);

    expect(recipients[0].config.finalFileUploadEnabled).toBe(false);
    expect(recipients[0].event.client.name).toBe("Client");
  });
});
