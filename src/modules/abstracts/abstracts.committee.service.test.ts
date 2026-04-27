/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import { AbstractStatus } from "@/generated/prisma/client.js";

vi.mock("@shared/utils/audit.js", () => ({
  auditLog: vi.fn(),
}));

import {
  assignReviewers,
  getAssignedAbstractDetail,
  listAssignedAbstracts,
  listCommitteeMembers,
  reviewAssignedAbstract,
} from "./abstracts.committee.service.js";

const eventId = "event-1";
const abstractId = "abstract-1";
const reviewerId = "reviewer-1";
const performedBy = "admin-1";

function makeAbstract(overrides: Record<string, unknown> = {}) {
  return {
    id: abstractId,
    eventId,
    authorFirstName: "Ada",
    authorLastName: "Lovelace",
    authorEmail: "ada@example.com",
    authorPhone: "+21612345678",
    coAuthors: [{ firstName: "Grace", lastName: "Hopper" }],
    requestedType: "ORAL_COMMUNICATION",
    finalType: null,
    content: { title: "Safe title", body: "Abstract body" },
    contentVersion: 1,
    additionalFieldsData: { institution: "PII" },
    code: null,
    codeNumber: null,
    status: AbstractStatus.SUBMITTED,
    averageScore: null,
    reviewCount: 0,
    finalFileKey: null,
    finalFileKind: null,
    finalFileSize: null,
    finalFileUploadedAt: null,
    editToken: "secret-token",
    lastEditedAt: null,
    linkBaseUrl: "https://events.example.com",
    registrationId: "registration-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

function activeReview(overrides: Record<string, unknown> = {}) {
  return {
    abstractId,
    eventId,
    reviewerId,
    active: true,
    score: null,
    comment: null,
    scoredAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

const forbiddenPiiKeys = [
  "authorEmail",
  "authorFirstName",
  "authorPhone",
  "coAuthors",
  "registrationId",
  "editToken",
  "linkBaseUrl",
  "additionalFieldsData",
];

function collectKeys(value: unknown, keys = new Set<string>()) {
  if (!value || typeof value !== "object") return keys;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    keys.add(key);
    collectKeys(nested, keys);
  }
  return keys;
}

describe("abstracts committee service", () => {
  describe("listCommitteeMembers", () => {
    it("returns active members with theme and active review counts", async () => {
      prismaMock.abstractCommitteeMembership.findMany.mockResolvedValue([
        {
          userId: "reviewer-1",
          eventId,
          active: true,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          user: { id: "reviewer-1", email: "one@example.com", name: "One", active: true },
        },
        {
          userId: "reviewer-2",
          eventId,
          active: true,
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
          user: { id: "reviewer-2", email: "two@example.com", name: "Two", active: true },
        },
      ] as any);
      prismaMock.abstractReviewerTheme.findMany.mockResolvedValue([
        { userId: "reviewer-1", themeId: "theme-1" },
        { userId: "reviewer-1", themeId: "theme-2" },
      ] as any);
      (prismaMock.abstractReview.groupBy as any)
        .mockResolvedValueOnce([{ reviewerId: "reviewer-1", _count: { _all: 2 } }] as any)
        .mockResolvedValueOnce([{ reviewerId: "reviewer-1", _count: { _all: 1 } }] as any);

      const result = await listCommitteeMembers(eventId);

      expect(result).toEqual([
        {
          userId: "reviewer-1",
          email: "one@example.com",
          name: "One",
          active: true,
          themeIds: ["theme-1", "theme-2"],
          assignedCount: 2,
          scoredCount: 1,
        },
        {
          userId: "reviewer-2",
          email: "two@example.com",
          name: "Two",
          active: true,
          themeIds: [],
          assignedCount: 0,
          scoredCount: 0,
        },
      ]);
      expect(prismaMock.abstractCommitteeMembership.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { eventId, active: true } }),
      );
      expect(prismaMock.abstractReview.groupBy).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: { eventId, reviewerId: { in: ["reviewer-1", "reviewer-2"] }, active: true },
        }),
      );
      expect(prismaMock.abstractReview.groupBy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: {
            eventId,
            reviewerId: { in: ["reviewer-1", "reviewer-2"] },
            active: true,
            scoredAt: { not: null },
          },
        }),
      );
    });
  });

  describe("assignReviewers", () => {
    it("rejects reviewers without active membership", async () => {
      prismaMock.abstract.findUnique.mockResolvedValue(makeAbstract() as any);
      prismaMock.abstractCommitteeMembership.findMany.mockResolvedValue([
        { userId: "reviewer-1" },
      ] as any);

      await expect(
        assignReviewers(eventId, abstractId, { reviewerIds: ["reviewer-1", "inactive-reviewer"] }, performedBy),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it("upserts active reviews, deactivates removed assignments, and moves submitted abstracts under review", async () => {
      prismaMock.abstract.findUnique.mockResolvedValue(
        makeAbstract({ status: AbstractStatus.SUBMITTED }) as any,
      );
      prismaMock.abstractCommitteeMembership.findMany.mockResolvedValue([
        { userId: "reviewer-1" },
        { userId: "reviewer-2" },
      ] as any);
      prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock));
      prismaMock.abstract.update.mockResolvedValue({
        id: abstractId,
        status: AbstractStatus.UNDER_REVIEW,
      } as any);

      const result = await assignReviewers(
        eventId,
        abstractId,
        { reviewerIds: ["reviewer-1", "reviewer-2"] },
        performedBy,
      );

      expect(prismaMock.abstractReview.updateMany).toHaveBeenCalledWith({
        where: {
          abstractId,
          active: true,
          reviewerId: { notIn: ["reviewer-1", "reviewer-2"] },
        },
        data: { active: false },
      });
      expect(prismaMock.abstractReview.upsert).toHaveBeenCalledWith({
        where: { abstractId_reviewerId: { abstractId, reviewerId: "reviewer-1" } },
        update: { eventId, active: true },
        create: { abstractId, eventId, reviewerId: "reviewer-1", active: true },
      });
      expect(prismaMock.abstractReview.upsert).toHaveBeenCalledWith({
        where: { abstractId_reviewerId: { abstractId, reviewerId: "reviewer-2" } },
        update: { eventId, active: true },
        create: { abstractId, eventId, reviewerId: "reviewer-2", active: true },
      });
      expect(prismaMock.abstract.update).toHaveBeenCalledWith({
        where: { id: abstractId },
        data: { status: AbstractStatus.UNDER_REVIEW },
        select: { id: true, status: true },
      });
      expect(result).toEqual({
        abstractId,
        status: AbstractStatus.UNDER_REVIEW,
        reviewerIds: ["reviewer-1", "reviewer-2"],
      });
    });
  });

  describe("assigned abstract DTOs", () => {
    it("returns anonymized assigned list items without author PII keys", async () => {
      prismaMock.abstractCommitteeMembership.findUnique.mockResolvedValue({
        userId: reviewerId,
        eventId,
        active: true,
      } as any);
      prismaMock.abstract.findMany.mockResolvedValue([
        {
          ...makeAbstract(),
          themes: [{ theme: { id: "theme-1", label: "Cardiology" } }],
          reviews: [activeReview({ reviewerId, score: 8, comment: "Good", scoredAt: new Date("2026-01-03T00:00:00.000Z") })],
        },
      ] as any);

      const result = await listAssignedAbstracts(eventId, reviewerId);
      const keys = collectKeys(result);

      for (const forbiddenKey of forbiddenPiiKeys) {
        expect(keys.has(forbiddenKey), forbiddenKey).toBe(false);
      }
      expect(result[0]).toMatchObject({
        id: abstractId,
        title: "Safe title",
        themeLabels: ["Cardiology"],
        ownReview: { score: 8, comment: "Good" },
      });
    });

    it("returns anonymized assigned detail without stored author PII keys", async () => {
      prismaMock.abstract.findUnique.mockResolvedValue({
        ...makeAbstract(),
        themes: [{ theme: { id: "theme-1", label: "Cardiology" } }],
        reviews: [activeReview({ reviewerId })],
      } as any);
      prismaMock.abstractCommitteeMembership.findUnique.mockResolvedValue({
        userId: reviewerId,
        eventId,
        active: true,
      } as any);

      const result = await getAssignedAbstractDetail(abstractId, reviewerId);
      const topLevelKeys = new Set(Object.keys(result));

      for (const forbiddenKey of forbiddenPiiKeys) {
        expect(topLevelKeys.has(forbiddenKey), forbiddenKey).toBe(false);
      }
      expect(result).toMatchObject({
        id: abstractId,
        eventId,
        content: { title: "Safe title", body: "Abstract body" },
        themeLabels: ["Cardiology"],
      });
    });
  });

  describe("reviewAssignedAbstract", () => {
    it("rejects scoring after the event scoring deadline", async () => {
      prismaMock.abstract.findUnique.mockResolvedValue({
        ...makeAbstract({ status: AbstractStatus.UNDER_REVIEW }),
        event: { abstractConfig: { scoringDeadline: new Date("2000-01-01T00:00:00.000Z") } },
        reviews: [activeReview({ reviewerId })],
      } as any);
      prismaMock.abstractCommitteeMembership.findUnique.mockResolvedValue({
        userId: reviewerId,
        eventId,
        active: true,
      } as any);

      await expect(
        reviewAssignedAbstract(abstractId, reviewerId, { score: 9, comment: "Strong" }),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it("updates own active review, recalculates active scores, and completes when all active reviews are scored", async () => {
      prismaMock.abstract.findUnique.mockResolvedValue({
        ...makeAbstract({ status: AbstractStatus.UNDER_REVIEW }),
        event: { abstractConfig: { scoringDeadline: new Date("2999-01-01T00:00:00.000Z") } },
        reviews: [activeReview({ reviewerId }), activeReview({ reviewerId: "reviewer-2" })],
      } as any);
      prismaMock.abstractCommitteeMembership.findUnique.mockResolvedValue({
        userId: reviewerId,
        eventId,
        active: true,
      } as any);
      prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock));
      prismaMock.abstractReview.findMany.mockResolvedValue([
        { score: 8, scoredAt: new Date("2026-01-03T00:00:00.000Z") },
        { score: 7, scoredAt: new Date("2026-01-04T00:00:00.000Z") },
      ] as any);
      prismaMock.abstract.update.mockResolvedValue({
        id: abstractId,
        status: AbstractStatus.REVIEW_COMPLETE,
        averageScore: 7.5,
        reviewCount: 2,
      } as any);

      const result = await reviewAssignedAbstract(abstractId, reviewerId, {
        score: 8,
        comment: "Strong",
      });

      expect(prismaMock.abstractReview.update).toHaveBeenCalledWith({
        where: { abstractId_reviewerId: { abstractId, reviewerId } },
        data: expect.objectContaining({
          eventId,
          active: true,
          score: 8,
          comment: "Strong",
          scoredAt: expect.any(Date),
        }),
      });
      expect(prismaMock.abstractReview.findMany).toHaveBeenCalledWith({
        where: { abstractId, active: true },
        select: { scoredAt: true, score: true },
      });
      expect(prismaMock.abstract.update).toHaveBeenCalledWith({
        where: { id: abstractId },
        data: {
          averageScore: 7.5,
          reviewCount: 2,
          status: AbstractStatus.REVIEW_COMPLETE,
        },
        select: { id: true, status: true, averageScore: true, reviewCount: true },
      });
      expect(result).toEqual({
        id: abstractId,
        status: AbstractStatus.REVIEW_COMPLETE,
        averageScore: 7.5,
        reviewCount: 2,
      });
    });
  });
});
