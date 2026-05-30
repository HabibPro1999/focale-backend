/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import { AbstractStatus } from "@/generated/prisma/client.js";

vi.mock("@shared/utils/audit.js", () => ({ auditLog: vi.fn() }));

import { finalizeAbstract, reopenAbstract } from "./abstracts.admin.service.js";

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
