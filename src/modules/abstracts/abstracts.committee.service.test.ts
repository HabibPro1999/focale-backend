/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, it, expect, vi } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import { firebaseAuthMock } from "../../../tests/mocks/firebase.js";
import { AbstractStatus } from "@/generated/prisma/client.js";
import { UserRole } from "@shared/constants/roles.js";

vi.mock("@shared/utils/audit.js", () => ({
  auditLog: vi.fn(),
}));

const sendEmailMock = vi.fn();

const createFirebaseUserMock = firebaseAuthMock.createUser;
const setCustomClaimsMock = firebaseAuthMock.setCustomUserClaims;
const deleteFirebaseUserMock = firebaseAuthMock.deleteUser;
const generatePasswordResetLinkMock =
  firebaseAuthMock.generatePasswordResetLink;
const updateFirebaseUserPasswordMock =
  firebaseAuthMock.updateFirebaseUserPassword;
const revokeFirebaseRefreshTokensMock =
  firebaseAuthMock.revokeFirebaseRefreshTokens;

vi.mock("@modules/email/email-sendgrid.service.js", () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...args),
}));

import { auditLog } from "@shared/utils/audit.js";
import {
  addCommitteeMember,
  assignReviewers,
  getAssignedAbstractDetail,
  listAssignedAbstracts,
  listCommitteeMembers,
  resendCommitteeInvite,
  reviewAssignedAbstract,
  setCommitteeMemberPassword,
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
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    keys.add(key);
    collectKeys(nested, keys);
  }
  return keys;
}

function makeCommitteeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "committee-user-1",
    email: "committee@example.com",
    name: "Existing Committee",
    role: UserRole.SCIENTIFIC_COMMITTEE,
    clientId: null,
    active: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function mockCommitteeListResult(user: ReturnType<typeof makeCommitteeUser>) {
  prismaMock.abstractCommitteeMembership.findMany.mockResolvedValue([
    {
      userId: user.id,
      eventId,
      active: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      user,
    },
  ] as any);
  prismaMock.abstractReviewerTheme.findMany.mockResolvedValue([]);
  (prismaMock.abstractReview.groupBy as any)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([]);
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
          user: {
            id: "reviewer-1",
            email: "one@example.com",
            name: "One",
            active: true,
          },
        },
        {
          userId: "reviewer-2",
          eventId,
          active: true,
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
          user: {
            id: "reviewer-2",
            email: "two@example.com",
            name: "Two",
            active: true,
          },
        },
      ] as any);
      prismaMock.abstractReviewerTheme.findMany.mockResolvedValue([
        { userId: "reviewer-1", themeId: "theme-1" },
        { userId: "reviewer-1", themeId: "theme-2" },
      ] as any);
      (prismaMock.abstractReview.groupBy as any)
        .mockResolvedValueOnce([
          { reviewerId: "reviewer-1", _count: { _all: 2 } },
        ] as any)
        .mockResolvedValueOnce([
          { reviewerId: "reviewer-1", _count: { _all: 1 } },
        ] as any);

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
      expect(
        prismaMock.abstractCommitteeMembership.findMany,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ where: { eventId, active: true } }),
      );
      expect(prismaMock.abstractReview.groupBy).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: {
            eventId,
            reviewerId: { in: ["reviewer-1", "reviewer-2"] },
            active: true,
          },
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
        assignReviewers(
          eventId,
          abstractId,
          { reviewerIds: ["reviewer-1", "inactive-reviewer"] },
          performedBy,
        ),
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
      prismaMock.$transaction.mockImplementation(async (callback: any) =>
        callback(prismaMock),
      );
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
        where: {
          abstractId_reviewerId: { abstractId, reviewerId: "reviewer-1" },
        },
        update: { eventId, active: true },
        create: { abstractId, eventId, reviewerId: "reviewer-1", active: true },
      });
      expect(prismaMock.abstractReview.upsert).toHaveBeenCalledWith({
        where: {
          abstractId_reviewerId: { abstractId, reviewerId: "reviewer-2" },
        },
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
          reviews: [
            activeReview({
              reviewerId,
              score: 8,
              comment: "Good",
              scoredAt: new Date("2026-01-03T00:00:00.000Z"),
            }),
          ],
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
        event: {
          abstractConfig: {
            scoringDeadline: new Date("2000-01-01T00:00:00.000Z"),
          },
        },
        reviews: [activeReview({ reviewerId })],
      } as any);
      prismaMock.abstractCommitteeMembership.findUnique.mockResolvedValue({
        userId: reviewerId,
        eventId,
        active: true,
      } as any);

      await expect(
        reviewAssignedAbstract(abstractId, reviewerId, {
          score: 9,
          comment: "Strong",
        }),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it("updates own active review, recalculates active scores, and completes when all active reviews are scored", async () => {
      prismaMock.abstract.findUnique.mockResolvedValue({
        ...makeAbstract({ status: AbstractStatus.UNDER_REVIEW }),
        event: {
          abstractConfig: {
            scoringDeadline: new Date("2999-01-01T00:00:00.000Z"),
          },
        },
        reviews: [
          activeReview({ reviewerId }),
          activeReview({ reviewerId: "reviewer-2" }),
        ],
      } as any);
      prismaMock.abstractCommitteeMembership.findUnique.mockResolvedValue({
        userId: reviewerId,
        eventId,
        active: true,
      } as any);
      prismaMock.$transaction.mockImplementation(async (callback: any) =>
        callback(prismaMock),
      );
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
        select: {
          id: true,
          status: true,
          averageScore: true,
          reviewCount: true,
        },
      });
      expect(result).toEqual({
        id: abstractId,
        status: AbstractStatus.REVIEW_COMPLETE,
        averageScore: 7.5,
        reviewCount: 2,
      });
    });
  });

  describe("addCommitteeMember", () => {
    beforeEach(() => {
      createFirebaseUserMock.mockReset();
      setCustomClaimsMock.mockReset();
      deleteFirebaseUserMock.mockReset();
      generatePasswordResetLinkMock.mockReset();
      sendEmailMock.mockReset();
      (auditLog as any).mockReset?.();
    });

    it.each([
      ["adds membership to another event", makeCommitteeUser()],
      [
        "reactivates membership in the current event",
        makeCommitteeUser({ id: "same-event-member" }),
      ],
    ])(
      "%s when an active committee user already exists by email",
      async (_caseName, user) => {
        prismaMock.user.findUnique.mockResolvedValue(user as any);
        mockCommitteeListResult(user);

        const result = await addCommitteeMember(
          eventId,
          { email: user.email, name: "Ignored Name" },
          performedBy,
        );

        expect(result).toMatchObject({
          userId: user.id,
          email: user.email,
          existingUserAdded: true,
        });
        expect(createFirebaseUserMock).not.toHaveBeenCalled();
        expect(generatePasswordResetLinkMock).not.toHaveBeenCalled();
        expect(sendEmailMock).not.toHaveBeenCalled();
        expect(
          prismaMock.abstractCommitteeMembership.upsert,
        ).toHaveBeenCalledWith({
          where: { userId_eventId: { userId: user.id, eventId } },
          update: { active: true },
          create: { userId: user.id, eventId, active: true },
        });
      },
    );

    it("returns a clear error when the email belongs to an admin account", async () => {
      const adminUser = makeCommitteeUser({
        role: UserRole.SUPER_ADMIN,
        email: "admin@example.com",
      });
      prismaMock.user.findUnique.mockResolvedValue(adminUser as any);

      await expect(
        addCommitteeMember(
          eventId,
          { email: adminUser.email, name: "Admin User" },
          performedBy,
        ),
      ).rejects.toMatchObject({
        statusCode: 400,
        message:
          "This email belongs to an admin account. Admin accounts cannot be added as scientific committee members.",
      });

      expect(createFirebaseUserMock).not.toHaveBeenCalled();
      expect(
        prismaMock.abstractCommitteeMembership.upsert,
      ).not.toHaveBeenCalled();
    });

    it("returns a clear error when the email belongs to an inactive committee account", async () => {
      const inactiveUser = makeCommitteeUser({ active: false });
      prismaMock.user.findUnique.mockResolvedValue(inactiveUser as any);

      await expect(
        addCommitteeMember(
          eventId,
          { email: inactiveUser.email, name: inactiveUser.name },
          performedBy,
        ),
      ).rejects.toMatchObject({
        statusCode: 400,
        message:
          "This email belongs to an inactive scientific committee account. Reactivate the account before adding it to an event.",
      });

      expect(
        prismaMock.abstractCommitteeMembership.upsert,
      ).not.toHaveBeenCalled();
    });

    it("returns a clear error when the email belongs to a client-scoped committee account", async () => {
      const scopedUser = makeCommitteeUser({ clientId: "client-1" });
      prismaMock.user.findUnique.mockResolvedValue(scopedUser as any);

      await expect(
        addCommitteeMember(
          eventId,
          { email: scopedUser.email, name: scopedUser.name },
          performedBy,
        ),
      ).rejects.toMatchObject({
        statusCode: 400,
        message:
          "This email belongs to a client-scoped account. Only unscoped scientific committee accounts can be added as committee members.",
      });

      expect(
        prismaMock.abstractCommitteeMembership.upsert,
      ).not.toHaveBeenCalled();
    });

    it("creates a new Firebase and database user, adds membership, and sends the invite when the email is new", async () => {
      const user = makeCommitteeUser({
        id: "new-firebase-uid",
        email: "new-committee@example.com",
        name: "New Committee",
      });
      prismaMock.user.findUnique.mockResolvedValue(null);
      createFirebaseUserMock.mockResolvedValue({ uid: user.id });
      setCustomClaimsMock.mockResolvedValue(undefined);
      prismaMock.user.create.mockResolvedValue(user as any);
      prismaMock.event.findUnique.mockResolvedValue({
        name: "Big Event",
      } as any);
      generatePasswordResetLinkMock.mockResolvedValue(
        "https://admin.example/auth/action?oobCode=abc",
      );
      sendEmailMock.mockResolvedValue({ success: true });
      mockCommitteeListResult(user);

      const result = await addCommitteeMember(
        eventId,
        { email: user.email, name: user.name },
        performedBy,
      );

      expect(result).toMatchObject({
        userId: user.id,
        inviteEmailSent: true,
      });
      expect(result).not.toHaveProperty("existingUserAdded");
      expect(createFirebaseUserMock).toHaveBeenCalledWith(
        user.email,
        expect.any(String),
      );
      expect(setCustomClaimsMock).toHaveBeenCalledWith(user.id, {
        role: UserRole.SCIENTIFIC_COMMITTEE,
        clientId: null,
      });
      expect(prismaMock.user.create).toHaveBeenCalledWith({
        data: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: UserRole.SCIENTIFIC_COMMITTEE,
          clientId: null,
        },
      });
      expect(generatePasswordResetLinkMock).toHaveBeenCalledWith(
        user.email,
        expect.objectContaining({
          url: expect.stringContaining("/committee"),
        }),
      );
      expect(sendEmailMock).toHaveBeenCalledWith(
        expect.objectContaining({
          to: user.email,
          subject:
            "You've been invited to the scientific committee for Big Event",
          categories: ["committee-invite"],
        }),
      );
    });
  });

  describe("resendCommitteeInvite", () => {
    const targetUserId = "reviewer-9";
    const activeCommitteeMember = {
      userId: targetUserId,
      eventId,
      active: true,
      user: {
        email: "reviewer9@example.com",
        name: "Reviewer Nine",
      },
      event: { name: "Big Event" },
    };

    beforeEach(() => {
      generatePasswordResetLinkMock.mockReset();
      sendEmailMock.mockReset();
      (auditLog as any).mockReset?.();
    });

    it("returns 404 when membership is missing or inactive", async () => {
      prismaMock.abstractCommitteeMembership.findUnique.mockResolvedValue(null);

      await expect(
        resendCommitteeInvite(eventId, targetUserId, performedBy),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(generatePasswordResetLinkMock).not.toHaveBeenCalled();
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it("returns 404 when membership exists but is inactive", async () => {
      prismaMock.abstractCommitteeMembership.findUnique.mockResolvedValue({
        userId: targetUserId,
        eventId,
        active: false,
      } as any);

      await expect(
        resendCommitteeInvite(eventId, targetUserId, performedBy),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(generatePasswordResetLinkMock).not.toHaveBeenCalled();
    });

    it("generates a reset link, sends the email, and audit-logs on success", async () => {
      prismaMock.abstractCommitteeMembership.findUnique.mockResolvedValue(
        activeCommitteeMember as any,
      );
      generatePasswordResetLinkMock.mockResolvedValue(
        "https://admin.example/auth/action?oobCode=abc",
      );
      sendEmailMock.mockResolvedValue({ success: true });

      const result = await resendCommitteeInvite(
        eventId,
        targetUserId,
        performedBy,
      );

      expect(result).toEqual({ inviteEmailSent: true });
      expect(generatePasswordResetLinkMock).toHaveBeenCalledWith(
        "reviewer9@example.com",
        expect.objectContaining({
          url: expect.stringContaining("/committee"),
        }),
      );
      expect(sendEmailMock).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "reviewer9@example.com",
          subject: "Reset your committee password",
          categories: ["committee-password-reset"],
        }),
      );
      expect(auditLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          entityType: "User",
          entityId: targetUserId,
          action: "admin_reset_password",
          changes: { method: { old: null, new: "email_link" } },
          performedBy,
        }),
      );
    });

    it("reports inviteEmailSent=false when SendGrid fails (still audit-logs the admin action)", async () => {
      prismaMock.abstractCommitteeMembership.findUnique.mockResolvedValue(
        activeCommitteeMember as any,
      );
      generatePasswordResetLinkMock.mockResolvedValue(
        "https://admin.example/auth/action?oobCode=abc",
      );
      sendEmailMock.mockResolvedValue({
        success: false,
        error: "sendgrid down",
      });

      const result = await resendCommitteeInvite(
        eventId,
        targetUserId,
        performedBy,
      );

      expect(result).toEqual({ inviteEmailSent: false });
      expect(auditLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "admin_reset_password",
          changes: { method: { old: null, new: "email_link" } },
        }),
      );
    });

    it("reports inviteEmailSent=false when generatePasswordResetLink throws", async () => {
      prismaMock.abstractCommitteeMembership.findUnique.mockResolvedValue(
        activeCommitteeMember as any,
      );
      generatePasswordResetLinkMock.mockRejectedValue(
        new Error("firebase down"),
      );

      const result = await resendCommitteeInvite(
        eventId,
        targetUserId,
        performedBy,
      );

      expect(result).toEqual({ inviteEmailSent: false });
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(auditLog).toHaveBeenCalled();
    });
  });

  describe("setCommitteeMemberPassword", () => {
    const targetUserId = "reviewer-9";
    const newPassword = "ZxcvbN!ZxcvbN1";

    beforeEach(() => {
      updateFirebaseUserPasswordMock.mockReset();
      revokeFirebaseRefreshTokensMock.mockReset();
      (auditLog as any).mockReset?.();
    });

    it("returns 404 when committee member does not exist", async () => {
      prismaMock.abstractCommitteeMembership.findUnique.mockResolvedValue(null);

      await expect(
        setCommitteeMemberPassword(
          eventId,
          targetUserId,
          newPassword,
          performedBy,
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(updateFirebaseUserPasswordMock).not.toHaveBeenCalled();
      expect(revokeFirebaseRefreshTokensMock).not.toHaveBeenCalled();
    });

    it("calls updateUser and revokeRefreshTokens, audit-logs without password", async () => {
      prismaMock.abstractCommitteeMembership.findUnique.mockResolvedValue({
        userId: targetUserId,
        eventId,
        active: true,
      } as any);
      updateFirebaseUserPasswordMock.mockResolvedValue(undefined);
      revokeFirebaseRefreshTokensMock.mockResolvedValue(undefined);

      const result = await setCommitteeMemberPassword(
        eventId,
        targetUserId,
        newPassword,
        performedBy,
      );

      expect(result).toEqual({ ok: true });
      expect(updateFirebaseUserPasswordMock).toHaveBeenCalledWith(
        targetUserId,
        newPassword,
      );
      expect(revokeFirebaseRefreshTokensMock).toHaveBeenCalledWith(
        targetUserId,
      );
      expect(auditLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          entityType: "User",
          entityId: targetUserId,
          action: "admin_reset_password",
          changes: { method: { old: null, new: "direct" } },
          performedBy,
        }),
      );
      // Sanity check: the audit changes payload must not leak the password.
      const auditCall = (auditLog as any).mock.calls.at(-1)?.[1];
      expect(JSON.stringify(auditCall ?? {})).not.toContain(newPassword);
    });
  });
});
