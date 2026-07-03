import { describe, it, expect, beforeEach, vi } from "vitest";
import { UserRole } from "@app/contracts";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock("@app/db", () => ({
  findAbstractMembership: vi.fn(),
  findEventClientId: vi.fn(),
  findEventName: vi.fn(),
  listActiveReviewerThemeIds: vi.fn(),
  listCommitteeMembers: vi.fn(),
  getCommitteeProfile: vi.fn(),
  upsertCommitteeMembership: vi.fn(),
  deactivateCommitteeMembershipTxn: vi.fn(),
  getActiveThemeIdsForEvent: vi.fn(),
  setReviewerThemesTxn: vi.fn(),
  findCommitteeInviteTarget: vi.fn(),
  findAbstractBasic: vi.fn(),
  getCommitteeConfig: vi.fn(),
  findScoredReviewScores: vi.fn(),
  findActiveMembershipUserIds: vi.fn(),
  assignReviewersTxn: vi.fn(),
  listAssignedAbstracts: vi.fn(),
  getAssignedAbstractRow: vi.fn(),
  findAbstractForReview: vi.fn(),
  reviewAbstractTxn: vi.fn(),
  writeAbstractAuditLog: vi.fn(),
  getUserByEmail: vi.fn(),
  getUserById: vi.fn(),
}));

const sendEmailMock = vi.fn();
vi.mock("@app/integrations", () => ({
  generatePasswordResetLink: vi.fn(),
  updateFirebaseUserPassword: vi.fn(),
  revokeFirebaseRefreshTokens: vi.fn(),
  getEmailProvider: () => ({ sendEmail: sendEmailMock }),
  compileMjmlToHtml: () => ({ html: "<html></html>" }),
}));

const assertClientModuleEnabledMock = vi.fn();
vi.mock("../clients/module-gates", () => ({
  assertClientModuleEnabled: (...args: unknown[]) =>
    assertClientModuleEnabledMock(...args),
}));

vi.mock("../identity/users.service", () => ({ UsersService: class {} }));
vi.mock("../../core/logger.service", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import {
  findAbstractMembership,
  findEventClientId,
  findEventName,
  listActiveReviewerThemeIds,
  listCommitteeMembers,
  upsertCommitteeMembership,
  deactivateCommitteeMembershipTxn,
  getActiveThemeIdsForEvent,
  setReviewerThemesTxn,
  findCommitteeInviteTarget,
  findAbstractBasic,
  getCommitteeConfig,
  findScoredReviewScores,
  findActiveMembershipUserIds,
  assignReviewersTxn,
  listAssignedAbstracts,
  getAssignedAbstractRow,
  findAbstractForReview,
  reviewAbstractTxn,
  writeAbstractAuditLog,
  getUserByEmail,
  getUserById,
} from "@app/db";
import {
  generatePasswordResetLink,
  updateFirebaseUserPassword,
  revokeFirebaseRefreshTokens,
} from "@app/integrations";
import { AbstractsCommitteeService } from "./abstracts.committee.service";
import { AppException } from "../../core/app-exception";

const mock = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

const eventId = "11111111-1111-1111-1111-111111111111";
const abstractId = "22222222-2222-2222-2222-222222222222";
const reviewerId = "reviewer-1";
const performedBy = "admin-1";

const usersMock = { createUser: vi.fn() };
const config = { urls: { adminAppUrl: "https://admin.example" } };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const service = new AbstractsCommitteeService(usersMock as any, config as any);

async function expectStatus(p: Promise<unknown>, status: number): Promise<void> {
  const err = await p.then(
    () => {
      throw new Error("expected promise to reject");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppException);
  expect((err as AppException).getStatus()).toBe(status);
}

function committeeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "committee-user-1",
    email: "committee@example.com",
    name: "Existing Committee",
    role: UserRole.SCIENTIFIC_COMMITTEE,
    clientId: null,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function memberDto(user: ReturnType<typeof committeeUser>) {
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    active: true,
    themeIds: [] as string[],
    assignedCount: 0,
    scoredCount: 0,
  };
}

const PII_KEYS = [
  "authorEmail",
  "authorAffiliation",
  "authorFirstName",
  "authorLastName",
  "authorPhone",
  "coAuthors",
  "registrationId",
  "editToken",
  "linkBaseUrl",
  "additionalFieldsData",
];

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return keys;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    keys.add(k);
    collectKeys(v, keys);
  }
  return keys;
}

function reviewerAbstractRow(overrides: Record<string, unknown> = {}) {
  return {
    id: abstractId,
    eventId,
    authorFirstName: "Ada",
    authorLastName: "Lovelace",
    authorAffiliation: "Analytical Institute",
    authorEmail: "ada@example.com",
    authorEmailNormalized: "ada@example.com",
    authorPhone: "+21612345678",
    requestedType: "ORAL_COMMUNICATION",
    content: { title: "Safe title", body: "Body" },
    coAuthors: [{ firstName: "Grace", lastName: "Hopper" }],
    additionalFieldsData: { institution: "PII" },
    code: null,
    codeNumber: null,
    status: "SUBMITTED",
    contentVersion: 1,
    finalType: null,
    averageScore: 15,
    reviewCount: 1,
    presentedAt: null,
    presentedBy: null,
    finalFileKey: null,
    finalFileKind: null,
    finalFileSize: null,
    finalFileUploadedAt: null,
    editToken: "secret-token",
    lastEditedAt: null,
    linkBaseUrl: "https://events.example.com",
    registrationId: "registration-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    themes: [{ id: "theme-1", label: "Cardiology" }],
    reviews: [
      {
        abstractId,
        eventId,
        reviewerId,
        active: true,
        score: 8,
        comment: "Good",
        scoredAt: new Date(),
      },
    ],
    ...overrides,
  };
}

/** Wire up the assertActiveMembership happy path. */
function grantActiveMembership() {
  mock(findAbstractMembership).mockResolvedValue({ active: true });
  mock(findEventClientId).mockResolvedValue({ id: eventId, clientId: "client-1" });
  assertClientModuleEnabledMock.mockResolvedValue(undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  assertClientModuleEnabledMock.mockResolvedValue(undefined);
});

// ===========================================================================
// addCommitteeMember
// ===========================================================================
describe("addCommitteeMember", () => {
  it("reuses an existing committee user by email, marks existingUserAdded + sends invite", async () => {
    const user = committeeUser();
    mock(getUserByEmail).mockResolvedValue(user);
    mock(findEventName).mockResolvedValue("Big Event");
    mock(generatePasswordResetLink).mockResolvedValue("https://reset/link");
    sendEmailMock.mockResolvedValue({ success: true });
    mock(listCommitteeMembers).mockResolvedValue([memberDto(user)]);

    const result = await service.addCommitteeMember(
      eventId,
      { email: user.email, name: "Ignored" },
      performedBy,
    );

    expect(result).toMatchObject({
      userId: user.id,
      existingUserAdded: true,
      inviteEmailSent: true,
    });
    expect(usersMock.createUser).not.toHaveBeenCalled();
    expect(upsertCommitteeMembership).toHaveBeenCalledWith(eventId, user.id);
    expect(generatePasswordResetLink).toHaveBeenCalledWith(
      user.email,
      expect.objectContaining({ url: expect.stringContaining("/committee") }),
    );
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: user.email,
        subject: "Invitation au comité scientifique - Big Event",
        categories: ["committee-invite"],
      }),
    );
  });

  it("creates a new committee user when the email is unknown (no existingUserAdded)", async () => {
    const user = committeeUser({ id: "new-uid", email: "new@example.com" });
    mock(getUserByEmail).mockResolvedValue(undefined);
    usersMock.createUser.mockResolvedValue(user);
    mock(findEventName).mockResolvedValue("Big Event");
    mock(generatePasswordResetLink).mockResolvedValue("https://reset/link");
    sendEmailMock.mockResolvedValue({ success: true });
    mock(listCommitteeMembers).mockResolvedValue([memberDto(user)]);

    const result = await service.addCommitteeMember(
      eventId,
      { email: user.email, name: "New Committee" },
      performedBy,
    );

    expect(usersMock.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: user.email,
        name: "New Committee",
        role: UserRole.SCIENTIFIC_COMMITTEE,
        clientId: null,
      }),
    );
    expect(result).toMatchObject({ userId: user.id, inviteEmailSent: true });
    expect(result).not.toHaveProperty("existingUserAdded");
  });

  it("reports inviteEmailSent=false when the invite throws, without rolling back membership", async () => {
    const user = committeeUser();
    mock(getUserByEmail).mockResolvedValue(user);
    mock(findEventName).mockResolvedValue("Big Event");
    mock(generatePasswordResetLink).mockRejectedValue(new Error("firebase down"));
    mock(listCommitteeMembers).mockResolvedValue([memberDto(user)]);

    const result = await service.addCommitteeMember(
      eventId,
      { email: user.email, name: "x" },
      performedBy,
    );

    expect(result.inviteEmailSent).toBe(false);
    expect(upsertCommitteeMembership).toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "admin account",
      committeeUser({ role: UserRole.SUPER_ADMIN }),
      "This email belongs to an admin account. Admin accounts cannot be added as scientific committee members.",
    ],
    [
      "inactive account",
      committeeUser({ active: false }),
      "This email belongs to an inactive scientific committee account. Reactivate the account before adding it to an event.",
    ],
    [
      "client-scoped account",
      committeeUser({ clientId: "client-1" }),
      "This email belongs to a client-scoped account. Only unscoped scientific committee accounts can be added as committee members.",
    ],
  ])("rejects a %s with 400 and does not upsert", async (_c, user, message) => {
    mock(getUserByEmail).mockResolvedValue(user);
    const err = await service
      .addCommitteeMember(eventId, { email: user.email, name: "x" }, performedBy)
      .catch((e) => e);
    expect(err).toBeInstanceOf(AppException);
    expect((err as AppException).getStatus()).toBe(400);
    expect((err as AppException).getResponse()).toMatchObject({ message });
    expect(upsertCommitteeMembership).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// removeCommitteeMember
// ===========================================================================
describe("removeCommitteeMember", () => {
  it("deactivates the membership + reviewer themes and audit-logs", async () => {
    grantActiveMembership();
    await service.removeCommitteeMember(eventId, reviewerId, performedBy);
    expect(deactivateCommitteeMembershipTxn).toHaveBeenCalledWith(
      eventId,
      reviewerId,
    );
    expect(writeAbstractAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "deactivate" }),
    );
  });

  it("403s when the target is not an active member", async () => {
    mock(findAbstractMembership).mockResolvedValue({ active: false });
    await expectStatus(
      service.removeCommitteeMember(eventId, reviewerId, performedBy),
      403,
    );
    expect(deactivateCommitteeMembershipTxn).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// setReviewerThemes
// ===========================================================================
describe("setReviewerThemes", () => {
  it("dedupes and replaces the active set with valid themes", async () => {
    grantActiveMembership();
    mock(getActiveThemeIdsForEvent).mockResolvedValue(["theme-1", "theme-2"]);
    mock(listCommitteeMembers).mockResolvedValue([
      { userId: reviewerId, email: "r@x.com", name: "R", active: true, themeIds: ["theme-1"], assignedCount: 0, scoredCount: 0 },
    ]);

    await service.setReviewerThemes(
      eventId,
      reviewerId,
      { themeIds: ["theme-1", "theme-1"] },
      performedBy,
    );

    expect(setReviewerThemesTxn).toHaveBeenCalledWith(eventId, reviewerId, [
      "theme-1",
    ]);
    expect(writeAbstractAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "replace" }),
    );
  });

  it("400s (ABSTRACT_INVALID_THEMES) when a theme is not active", async () => {
    grantActiveMembership();
    mock(getActiveThemeIdsForEvent).mockResolvedValue(["theme-1"]);
    const err = await service
      .setReviewerThemes(eventId, reviewerId, { themeIds: ["nope"] }, performedBy)
      .catch((e) => e);
    expect((err as AppException).getStatus()).toBe(400);
    expect((err as AppException).getResponse()).toMatchObject({
      code: "ABS_18004",
    });
    expect(setReviewerThemesTxn).not.toHaveBeenCalled();
  });

  it("404s when the event has no abstract config", async () => {
    grantActiveMembership();
    mock(getActiveThemeIdsForEvent).mockResolvedValue(null);
    await expectStatus(
      service.setReviewerThemes(eventId, reviewerId, { themeIds: [] }, performedBy),
      404,
    );
  });
});

// ===========================================================================
// assignReviewers
// ===========================================================================
describe("assignReviewers", () => {
  beforeEach(() => {
    mock(findAbstractBasic).mockResolvedValue({
      id: abstractId,
      eventId,
      status: "SUBMITTED",
    });
    mock(getCommitteeConfig).mockResolvedValue({
      reviewersPerAbstract: 2,
      divergenceThreshold: 6,
    });
  });

  it("assigns the exact required count and returns the thin DTO", async () => {
    mock(findActiveMembershipUserIds).mockResolvedValue(["r1", "r2"]);
    mock(assignReviewersTxn).mockResolvedValue({
      id: abstractId,
      status: "UNDER_REVIEW",
    });

    const result = await service.assignReviewers(
      eventId,
      abstractId,
      { reviewerIds: ["r1", "r2"] },
      performedBy,
    );

    expect(assignReviewersTxn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId,
        abstractId,
        reviewerIds: ["r1", "r2"],
        currentStatus: "SUBMITTED",
      }),
    );
    expect(result).toEqual({
      abstractId,
      status: "UNDER_REVIEW",
      reviewerIds: ["r1", "r2"],
    });
  });

  it("400s when fewer than the required reviewers are given (no txn)", async () => {
    await expectStatus(
      service.assignReviewers(eventId, abstractId, { reviewerIds: ["r1"] }, performedBy),
      400,
    );
    expect(assignReviewersTxn).not.toHaveBeenCalled();
  });

  it("400s when a reviewer lacks active membership (no txn)", async () => {
    mock(findActiveMembershipUserIds).mockResolvedValue(["r1"]);
    await expectStatus(
      service.assignReviewers(
        eventId,
        abstractId,
        { reviewerIds: ["r1", "r2"] },
        performedBy,
      ),
      400,
    );
    expect(assignReviewersTxn).not.toHaveBeenCalled();
  });

  it("400s on extra reviewers without a score-divergence alert", async () => {
    mock(findScoredReviewScores).mockResolvedValue([10, 10]); // spread 0 < threshold 6
    const err = await service
      .assignReviewers(
        eventId,
        abstractId,
        { reviewerIds: ["r1", "r2", "r3"] },
        performedBy,
      )
      .catch((e) => e);
    expect((err as AppException).getStatus()).toBe(400);
    expect(assignReviewersTxn).not.toHaveBeenCalled();
  });

  it("404s when the abstract is not in the event", async () => {
    mock(findAbstractBasic).mockResolvedValue({
      id: abstractId,
      eventId: "other-event",
      status: "SUBMITTED",
    });
    await expectStatus(
      service.assignReviewers(eventId, abstractId, { reviewerIds: [] }, performedBy),
      404,
    );
  });
});

// ===========================================================================
// listAssignedAbstracts / getAssignedAbstractDetail (anonymization)
// ===========================================================================
describe("reviewer reads (anonymized)", () => {
  it("strips all author PII, forces averageScore null, keeps ownReview", async () => {
    grantActiveMembership();
    mock(listAssignedAbstracts).mockResolvedValue([reviewerAbstractRow()]);

    const result = await service.listAssignedAbstracts(eventId, reviewerId);
    const keys = collectKeys(result);
    for (const forbidden of PII_KEYS) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
    expect(result[0]).toMatchObject({
      id: abstractId,
      title: "Safe title",
      themeLabels: ["Cardiology"],
      averageScore: null,
      ownReview: { score: 8, comment: "Good" },
    });
    expect(assertClientModuleEnabledMock).toHaveBeenCalledWith(
      "client-1",
      "abstracts",
    );
  });

  it("propagates a module-disabled gate and never queries abstracts", async () => {
    mock(findAbstractMembership).mockResolvedValue({ active: true });
    mock(findEventClientId).mockResolvedValue({ id: eventId, clientId: "client-1" });
    assertClientModuleEnabledMock.mockRejectedValue(new Error("module disabled"));

    await expect(
      service.listAssignedAbstracts(eventId, reviewerId),
    ).rejects.toThrow("module disabled");
    expect(listAssignedAbstracts).not.toHaveBeenCalled();
  });

  it("detail: 404s when neither an explicit review nor theme coverage applies", async () => {
    grantActiveMembership();
    mock(getAssignedAbstractRow).mockResolvedValue(
      reviewerAbstractRow({ reviews: [] }),
    );
    mock(listActiveReviewerThemeIds).mockResolvedValue([]); // no coverage
    await expectStatus(
      service.getAssignedAbstractDetail(abstractId, reviewerId),
      404,
    );
  });

  it("detail: allows access via theme coverage even without an explicit review", async () => {
    grantActiveMembership();
    mock(getAssignedAbstractRow).mockResolvedValue(
      reviewerAbstractRow({ reviews: [] }),
    );
    mock(listActiveReviewerThemeIds).mockResolvedValue(["theme-1"]);
    const result = await service.getAssignedAbstractDetail(abstractId, reviewerId);
    const keys = new Set(Object.keys(result));
    for (const forbidden of PII_KEYS) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
    expect(result).toMatchObject({ id: abstractId, averageScore: null });
  });
});

// ===========================================================================
// reviewAssignedAbstract
// ===========================================================================
describe("reviewAssignedAbstract", () => {
  function forReview(overrides: Record<string, unknown> = {}) {
    return {
      id: abstractId,
      eventId,
      status: "UNDER_REVIEW",
      clientId: "client-1",
      config: {
        scoringStartAt: null,
        scoringDeadline: null,
        divergenceThreshold: 6,
        commentsEnabled: true,
      },
      themes: [{ id: "theme-1", label: "Cardiology" }],
      reviews: [{ reviewerId, active: true }],
      ...overrides,
    };
  }

  it("scores, delegating aggregation to the txn", async () => {
    grantActiveMembership();
    mock(findAbstractForReview).mockResolvedValue(forReview());
    mock(listActiveReviewerThemeIds).mockResolvedValue([]);
    mock(reviewAbstractTxn).mockResolvedValue({
      id: abstractId,
      status: "REVIEW_COMPLETE",
      averageScore: 7.5,
      reviewCount: 2,
    });

    const result = await service.reviewAssignedAbstract(abstractId, reviewerId, {
      score: 8,
      comment: "Strong",
    });

    expect(reviewAbstractTxn).toHaveBeenCalledWith(
      expect.objectContaining({
        abstractId,
        eventId,
        reviewerId,
        clientId: "client-1",
        score: 8,
        comment: "Strong",
        commentsEnabled: true,
        divergenceThreshold: 6,
      }),
    );
    expect(result).toEqual({
      id: abstractId,
      status: "REVIEW_COMPLETE",
      averageScore: 7.5,
      reviewCount: 2,
    });
  });

  it("403s past the scoring deadline (no txn)", async () => {
    grantActiveMembership();
    mock(findAbstractForReview).mockResolvedValue(
      forReview({
        config: {
          scoringStartAt: null,
          scoringDeadline: new Date("2000-01-01T00:00:00.000Z"),
          divergenceThreshold: 6,
          commentsEnabled: true,
        },
      }),
    );
    mock(listActiveReviewerThemeIds).mockResolvedValue([]);
    await expectStatus(
      service.reviewAssignedAbstract(abstractId, reviewerId, { score: 9 }),
      403,
    );
    expect(reviewAbstractTxn).not.toHaveBeenCalled();
  });

  it("409s when the abstract is already finalized (no txn)", async () => {
    grantActiveMembership();
    mock(findAbstractForReview).mockResolvedValue(forReview({ status: "ACCEPTED" }));
    mock(listActiveReviewerThemeIds).mockResolvedValue([]);
    await expectStatus(
      service.reviewAssignedAbstract(abstractId, reviewerId, { score: 9 }),
      409,
    );
    expect(reviewAbstractTxn).not.toHaveBeenCalled();
  });

  it("400s when comments are disabled but a comment is supplied", async () => {
    grantActiveMembership();
    mock(findAbstractForReview).mockResolvedValue(
      forReview({
        config: {
          scoringStartAt: null,
          scoringDeadline: null,
          divergenceThreshold: 6,
          commentsEnabled: false,
        },
      }),
    );
    mock(listActiveReviewerThemeIds).mockResolvedValue([]);
    await expectStatus(
      service.reviewAssignedAbstract(abstractId, reviewerId, {
        score: 9,
        comment: "nope",
      }),
      400,
    );
  });
});

// ===========================================================================
// resendCommitteeInvite
// ===========================================================================
describe("resendCommitteeInvite", () => {
  const target = {
    active: true,
    userEmail: "r9@example.com",
    userName: "Reviewer Nine",
    eventName: "Big Event",
  };

  it("404s when the membership is missing or inactive", async () => {
    mock(findCommitteeInviteTarget).mockResolvedValue({ ...target, active: false });
    await expectStatus(
      service.resendCommitteeInvite(eventId, reviewerId, performedBy),
      404,
    );
    expect(generatePasswordResetLink).not.toHaveBeenCalled();
  });

  it("sends the reset email and audit-logs on success", async () => {
    mock(findCommitteeInviteTarget).mockResolvedValue(target);
    mock(generatePasswordResetLink).mockResolvedValue("https://reset/link");
    sendEmailMock.mockResolvedValue({ success: true });

    const result = await service.resendCommitteeInvite(
      eventId,
      reviewerId,
      performedBy,
    );

    expect(result).toEqual({ inviteEmailSent: true });
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "r9@example.com",
        subject: "Réinitialisation du mot de passe comité",
        categories: ["committee-password-reset"],
      }),
    );
    expect(writeAbstractAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "User",
        action: "admin_reset_password",
        changes: { method: { old: null, new: "email_link" } },
      }),
    );
  });

  it("reports false but still audit-logs when SendGrid fails", async () => {
    mock(findCommitteeInviteTarget).mockResolvedValue(target);
    mock(generatePasswordResetLink).mockResolvedValue("https://reset/link");
    sendEmailMock.mockResolvedValue({ success: false, error: "down" });

    const result = await service.resendCommitteeInvite(
      eventId,
      reviewerId,
      performedBy,
    );
    expect(result).toEqual({ inviteEmailSent: false });
    expect(writeAbstractAuditLog).toHaveBeenCalled();
  });

  it("reports false but still audit-logs when link generation throws", async () => {
    mock(findCommitteeInviteTarget).mockResolvedValue(target);
    mock(generatePasswordResetLink).mockRejectedValue(new Error("firebase"));

    const result = await service.resendCommitteeInvite(
      eventId,
      reviewerId,
      performedBy,
    );
    expect(result).toEqual({ inviteEmailSent: false });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(writeAbstractAuditLog).toHaveBeenCalled();
  });
});

// ===========================================================================
// setCommitteeMemberPassword
// ===========================================================================
describe("setCommitteeMemberPassword", () => {
  const newPassword = "ZxcvbN!ZxcvbN1";

  it("404s when the committee member does not exist", async () => {
    mock(findAbstractMembership).mockResolvedValue(null);
    await expectStatus(
      service.setCommitteeMemberPassword(eventId, reviewerId, newPassword, performedBy),
      404,
    );
    expect(updateFirebaseUserPassword).not.toHaveBeenCalled();
  });

  it("sets the password, revokes tokens, and audit-logs without leaking the password", async () => {
    mock(findAbstractMembership).mockResolvedValue({ active: true });

    const result = await service.setCommitteeMemberPassword(
      eventId,
      reviewerId,
      newPassword,
      performedBy,
    );

    expect(result).toEqual({ ok: true });
    expect(updateFirebaseUserPassword).toHaveBeenCalledWith(reviewerId, newPassword);
    expect(revokeFirebaseRefreshTokens).toHaveBeenCalledWith(reviewerId);
    const auditArg = mock(writeAbstractAuditLog).mock.calls.at(-1)?.[0];
    expect(auditArg).toMatchObject({
      action: "admin_reset_password",
      changes: { method: { old: null, new: "direct" } },
    });
    expect(JSON.stringify(auditArg ?? {})).not.toContain(newPassword);
  });
});
