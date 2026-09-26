import { describe, it, expect, beforeEach, vi } from "vitest";
import { ErrorCodes, UserRole } from "@app/contracts";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const { rootDb } = vi.hoisted(() => ({ rootDb: { executor: "root" } }));
vi.mock("@app/db", () => ({
  getDb: () => rootDb,
  findAbstractMembership: vi.fn(),
  deleteUnusedCommitteeInvites: vi.fn(),
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
  findAbstractThemeIds: vi.fn(),
  getReviewerAssignmentConfig: vi.fn(),
  findScoredReviewScores: vi.fn(),
  findActiveMembershipUserIds: vi.fn(),
  assignReviewersTxn: vi.fn(),
  listAssignedAbstracts: vi.fn(),
  getAssignedAbstractRow: vi.fn(),
  findAbstractForReview: vi.fn(),
  reviewAbstractTxn: vi.fn(),
  insertAuditLog: vi.fn(),
  getUserByEmail: vi.fn(),
  getUserById: vi.fn(),
  findCommitteeUserClientIds: vi.fn(),
  findAbstractEmailTemplate: vi.fn(),
}));

// sendEmailMock stands for the provider; sendEmailNow (3.6b) is faked on top
// of it: accepted → SENT, refused → FAILED, thrown → UNCERTAIN.
const sendEmailMock = vi.fn();
const sendEmailNowMock = vi.fn(async (input: { log?: unknown } & Record<string, unknown>) => {
  try {
    const result = (await sendEmailMock({ ...input, trackingId: "log-now" })) as {
      success: boolean;
      messageId?: string;
      error?: string;
    };
    return result.success
      ? { status: "SENT", emailLogId: "log-now", messageId: result.messageId }
      : { status: "FAILED", emailLogId: "log-now", error: result.error ?? "Unknown error" };
  } catch (err) {
    return { status: "UNCERTAIN", emailLogId: "log-now", error: String(err) };
  }
});
vi.mock("@app/integrations", () => ({
  updateFirebaseUserPassword: vi.fn(),
  revokeFirebaseRefreshTokens: vi.fn(),
  sendEmailNow: (input: never) => sendEmailNowMock(input),
  renderEmailLayout: (body: string, options?: { header?: string }) => `<layout header="${options?.header}">${body}</layout>`,
  compileMjmlToHtml: () => ({ html: "<html></html>" }),
  // Mirrors the real resolver's modes: html escapes values, text does not.
  resolveVariables: (
    template: string,
    vars: Record<string, string>,
    options?: { mode?: "html" | "text" },
  ) =>
    template.replace(/\{\{(\w+)\}\}/g, (_m, key) => {
      const value = vars[key] ?? "";
      return options?.mode === "text" ? value : value.replace(/&/g, "&amp;");
    }),
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
  findAbstractThemeIds,
  getReviewerAssignmentConfig,
  findScoredReviewScores,
  findActiveMembershipUserIds,
  assignReviewersTxn,
  listAssignedAbstracts,
  getAssignedAbstractRow,
  findAbstractForReview,
  reviewAbstractTxn,
  insertAuditLog,
  getUserByEmail,
  findCommitteeUserClientIds,
  findAbstractEmailTemplate,
} from "@app/db";
import {
  updateFirebaseUserPassword,
  revokeFirebaseRefreshTokens,
} from "@app/integrations";
import { CommitteeEmailsService } from "./abstracts.committee-emails";
import { AbstractsCommitteeService } from "./abstracts.committee.service";
import { AppException } from "../../core/app-exception";

const mock = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

const eventId = "11111111-1111-1111-1111-111111111111";
const abstractId = "22222222-2222-2222-2222-222222222222";
const reviewerId = "reviewer-1";
const performedBy = "admin-1";
const clientAdminCaller = {
  id: performedBy,
  role: UserRole.CLIENT_ADMIN,
  clientId: "client-1",
};
const superAdminCaller = {
  id: performedBy,
  role: UserRole.SUPER_ADMIN,
  clientId: null,
};

const usersMock = { createUser: vi.fn() };
const mintCommitteeInviteToken = vi.fn();
const config = { urls: { adminAppUrl: "https://admin.example" }, security: { committeeInvite: { tokenTtlDays: 7 } } };
const invites = { mintCommitteeInviteToken,
  buildCommitteeInviteLink: (token: string) => `https://admin.example/committee/set-password?token=${token}&lang=fr` };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const service = new AbstractsCommitteeService(usersMock as any, invites as any, new CommitteeEmailsService(config as any));

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
    mock(mintCommitteeInviteToken).mockResolvedValue("a".repeat(64));
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
    expect(mintCommitteeInviteToken).toHaveBeenCalledWith(
      user.id, eventId, performedBy,
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
    mock(mintCommitteeInviteToken).mockResolvedValue("a".repeat(64));
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

  // M7: ABSTRACT_COMMITTEE_INVITE was a configurable trigger nobody ever
  // consulted — the invite must render + send a configured template when one
  // exists, and fall back to the hardcoded MJML only when it doesn't.
  it("resolves a templated invite subject as text, not HTML (6.1)", async () => {
    const user = committeeUser({ name: "Zoë Martin & Fils" });
    mock(getUserByEmail).mockResolvedValue(user);
    mock(findEventName).mockResolvedValue("Big Event");
    mock(findEventClientId).mockResolvedValue({ id: eventId, clientId: "client-1" });
    mock(mintCommitteeInviteToken).mockResolvedValue("a".repeat(64));
    mock(findAbstractEmailTemplate).mockResolvedValue({
      id: "tmpl-1",
      subject: "Bienvenue {{reviewerName}}",
      htmlContent: "<p>Bonjour {{reviewerName}}</p>",
    });
    sendEmailMock.mockResolvedValue({ success: true });
    mock(listCommitteeMembers).mockResolvedValue([memberDto(user)]);

    await service.addCommitteeMember(eventId, { email: user.email, name: "Ignored" }, performedBy);

    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Bienvenue Zoë Martin & Fils",
        html: "<p>Bonjour Zoë Martin &amp; Fils</p>",
      }),
    );
  });

  it("M7: renders and sends a configured ABSTRACT_COMMITTEE_INVITE template instead of the hardcoded fallback", async () => {
    const user = committeeUser();
    mock(getUserByEmail).mockResolvedValue(user);
    mock(findEventName).mockResolvedValue("Big Event");
    mock(findEventClientId).mockResolvedValue({ id: eventId, clientId: "client-1" });
    mock(mintCommitteeInviteToken).mockResolvedValue("a".repeat(64));
    mock(findAbstractEmailTemplate).mockResolvedValue({
      id: "tmpl-1",
      subject: "Bienvenue {{reviewerName}} - {{eventName}}",
      htmlContent: "<p>Bonjour {{reviewerName}}, connectez-vous : {{loginLink}}</p>",
    });
    sendEmailMock.mockResolvedValue({ success: true });
    mock(listCommitteeMembers).mockResolvedValue([memberDto(user)]);

    const result = await service.addCommitteeMember(
      eventId,
      { email: user.email, name: "Ignored" },
      performedBy,
    );

    expect(result.inviteEmailSent).toBe(true);
    expect(findAbstractEmailTemplate).toHaveBeenCalledWith({
      clientId: "client-1",
      eventId,
      abstractTrigger: "ABSTRACT_COMMITTEE_INVITE",
    });
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: user.email,
        subject: `Bienvenue ${user.name} - Big Event`,
        html: expect.stringContaining("https://admin.example/committee/set-password?token=" + "a".repeat(64)),
      }),
    );
  });

  it("M7: falls back to the hardcoded MJML when no template is configured", async () => {
    const user = committeeUser();
    mock(getUserByEmail).mockResolvedValue(user);
    mock(findEventName).mockResolvedValue("Big Event");
    mock(findEventClientId).mockResolvedValue({ id: eventId, clientId: "client-1" });
    mock(mintCommitteeInviteToken).mockResolvedValue("a".repeat(64));
    mock(findAbstractEmailTemplate).mockResolvedValue(null);
    sendEmailMock.mockResolvedValue({ success: true });
    mock(listCommitteeMembers).mockResolvedValue([memberDto(user)]);

    const result = await service.addCommitteeMember(
      eventId,
      { email: user.email, name: "Ignored" },
      performedBy,
    );

    expect(result.inviteEmailSent).toBe(true);
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Invitation au comité scientifique - Big Event",
      }),
    );
  });

  // ---------------------------------------------------------------------------
  // M7 completion: both invite send paths must record an email_logs row
  // (ABSTRACT_COMMITTEE_INVITE) so invites show up in the admin's log table.
  // ---------------------------------------------------------------------------
  it("M7 gap: templated invite goes through sendEmailNow with an ABSTRACT_COMMITTEE_INVITE log (no registration/abstract link)", async () => {
    const user = committeeUser();
    mock(getUserByEmail).mockResolvedValue(user);
    mock(findEventName).mockResolvedValue("Big Event");
    mock(findEventClientId).mockResolvedValue({ id: eventId, clientId: "client-1" });
    mock(mintCommitteeInviteToken).mockResolvedValue("a".repeat(64));
    mock(findAbstractEmailTemplate).mockResolvedValue({
      id: "tmpl-1",
      subject: "Bienvenue {{reviewerName}} - {{eventName}}",
      htmlContent: "<p>Bonjour {{reviewerName}}, connectez-vous : {{loginLink}}</p>",
    });
    sendEmailMock.mockResolvedValue({ success: true, messageId: "msg-tmpl" });
    mock(listCommitteeMembers).mockResolvedValue([memberDto(user)]);

    const result = await service.addCommitteeMember(
      eventId,
      { email: user.email, name: "Ignored" },
      performedBy,
    );

    expect(result.inviteEmailSent).toBe(true);
    expect(sendEmailNowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: user.email,
        subject: `Bienvenue ${user.name} - Big Event`,
        categories: ["committee-invite"],
        log: { abstractTrigger: "ABSTRACT_COMMITTEE_INVITE" },
      }),
    );
  });

  it("M7 gap: the MJML fallback uses the shared layout and the same invite log", async () => {
    const user = committeeUser();
    mock(getUserByEmail).mockResolvedValue(user);
    mock(findEventName).mockResolvedValue("Big & Event");
    mock(findEventClientId).mockResolvedValue({ id: eventId, clientId: "client-1" });
    mock(mintCommitteeInviteToken).mockResolvedValue("a".repeat(64));
    mock(findAbstractEmailTemplate).mockResolvedValue(null);
    sendEmailMock.mockResolvedValue({ success: true, messageId: "msg-mjml" });
    mock(listCommitteeMembers).mockResolvedValue([memberDto(user)]);
    const compile = vi.spyOn(await import("@app/integrations"), "compileMjmlToHtml");

    const result = await service.addCommitteeMember(
      eventId,
      { email: user.email, name: "Ignored" },
      performedBy,
    );

    expect(result.inviteEmailSent).toBe(true);
    const mjml = compile.mock.calls[0]![0];
    expect(mjml).toMatch(/^<layout header="Big &amp; Event">/);
    expect(mjml).toContain(`href="https://admin.example/committee/set-password?token=${"a".repeat(64)}&amp;lang=fr"`);
    expect(mjml).toContain("valable 7 jour(s)");
    expect(sendEmailNowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: user.email,
        subject: "Invitation au comité scientifique - Big & Event",
        log: { abstractTrigger: "ABSTRACT_COMMITTEE_INVITE" },
      }),
    );
  });

  it("M7 gap: an unconfirmed send (UNCERTAIN) reports inviteEmailSent=false and leaves membership + audit intact", async () => {
    const user = committeeUser();
    mock(getUserByEmail).mockResolvedValue(user);
    mock(findEventName).mockResolvedValue("Big Event");
    mock(findEventClientId).mockResolvedValue({ id: eventId, clientId: "client-1" });
    mock(mintCommitteeInviteToken).mockResolvedValue("a".repeat(64));
    mock(findAbstractEmailTemplate).mockResolvedValue(null);
    sendEmailMock.mockRejectedValue(new Error("socket hang up"));
    mock(listCommitteeMembers).mockResolvedValue([memberDto(user)]);

    const result = await service.addCommitteeMember(
      eventId,
      { email: user.email, name: "x" },
      performedBy,
    );

    expect(result.inviteEmailSent).toBe(false);
    expect(await sendEmailNowMock.mock.results[0]!.value).toMatchObject({ status: "UNCERTAIN" });
    expect(upsertCommitteeMembership).toHaveBeenCalledWith(eventId, user.id);
    expect(insertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "AbstractCommitteeMembership" }),
      rootDb,
    );
  });

  it("reports inviteEmailSent=false when the email log cannot be written (nothing sent)", async () => {
    const user = committeeUser();
    mock(getUserByEmail).mockResolvedValue(user);
    mock(findEventName).mockResolvedValue("Big Event");
    mock(mintCommitteeInviteToken).mockResolvedValue("a".repeat(64));
    sendEmailNowMock.mockRejectedValueOnce(new Error("db down"));
    mock(listCommitteeMembers).mockResolvedValue([memberDto(user)]);

    const result = await service.addCommitteeMember(eventId, { email: user.email, name: "x" }, performedBy);

    expect(result.inviteEmailSent).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(upsertCommitteeMembership).toHaveBeenCalledWith(eventId, user.id);
  });

  it("M7 gap: the generated temporary password never appears in the email_logs row", async () => {
    const user = committeeUser({ id: "new-uid", email: "new@example.com" });
    mock(getUserByEmail).mockResolvedValue(undefined);
    usersMock.createUser.mockResolvedValue(user);
    mock(findEventName).mockResolvedValue("Big Event");
    mock(findEventClientId).mockResolvedValue({ id: eventId, clientId: "client-1" });
    mock(mintCommitteeInviteToken).mockResolvedValue("a".repeat(64));
    mock(findAbstractEmailTemplate).mockResolvedValue(null);
    sendEmailMock.mockResolvedValue({ success: true });
    mock(listCommitteeMembers).mockResolvedValue([memberDto(user)]);

    await service.addCommitteeMember(
      eventId,
      { email: user.email, name: "New Committee" },
      performedBy,
    );

    const generatedPassword = usersMock.createUser.mock.calls[0][0].password as string;
    expect(generatedPassword).toBeTruthy();

    // Nothing the send-now log records (recipient, subject, links) carries it.
    const [input] = sendEmailNowMock.mock.calls[0]!;
    const logged = JSON.stringify({ to: input.to, toName: input.toName, subject: input.subject, log: input.log });
    expect(logged).not.toContain(generatedPassword);
    expect(logged.toLowerCase()).not.toContain("password");
    expect(JSON.stringify(input)).not.toContain(generatedPassword);
  });

  it("reports inviteEmailSent=false when the invite throws, without rolling back membership", async () => {
    const user = committeeUser();
    mock(getUserByEmail).mockResolvedValue(user);
    mock(findEventName).mockResolvedValue("Big Event");
    mock(mintCommitteeInviteToken).mockRejectedValue(new Error("firebase down"));
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
  it("deactivates the membership + reviewer themes with its audit row in the same txn", async () => {
    grantActiveMembership();
    await service.removeCommitteeMember(eventId, reviewerId, performedBy);
    expect(deactivateCommitteeMembershipTxn).toHaveBeenCalledWith(
      eventId,
      reviewerId,
      {
        entityType: "AbstractCommitteeMembership",
        entityId: `${eventId}:${reviewerId}`,
        action: "deactivate",
        changes: { active: { old: true, new: false } },
        performedBy,
      },
    );
    // Not written separately after the transaction.
    expect(insertAuditLog).not.toHaveBeenCalled();
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

    expect(setReviewerThemesTxn).toHaveBeenCalledWith(
      eventId,
      reviewerId,
      ["theme-1"],
      {
        entityType: "AbstractReviewerTheme",
        entityId: `${eventId}:${reviewerId}`,
        action: "replace",
        changes: { themeIds: { old: null, new: ["theme-1"] } },
        performedBy,
      },
    );
    // Not written separately after the transaction.
    expect(insertAuditLog).not.toHaveBeenCalled();
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
    mock(getReviewerAssignmentConfig).mockResolvedValue({
      reviewersPerAbstract: 2,
      divergenceThreshold: 6,
      distributeByTheme: false,
    });
  });

  it("assigns the exact required count and returns the thin DTO", async () => {
    mock(findActiveMembershipUserIds).mockResolvedValue(["r1", "r2"]);
    mock(assignReviewersTxn).mockResolvedValue({
      ok: true,
      id: abstractId,
      status: "UNDER_REVIEW",
    });

    const result = await service.assignReviewers(
      eventId,
      abstractId,
      { reviewerIds: ["r1", "r2"] },
      performedBy,
    );

    expect(assignReviewersTxn).toHaveBeenCalledWith({
      eventId,
      abstractId,
      reviewerIds: ["r1", "r2"],
      audit: {
        entityType: "Abstract",
        entityId: abstractId,
        action: "assign_reviewers",
        changes: { reviewerIds: { old: null, new: ["r1", "r2"] } },
        performedBy,
      },
    });
    // Written by the transaction, only when it assigns.
    expect(insertAuditLog).not.toHaveBeenCalled();
    expect(result).toEqual({
      abstractId,
      status: "UNDER_REVIEW",
      reviewerIds: ["r1", "r2"],
    });
  });

  it("409s on a finalized abstract before validating reviewers (no txn)", async () => {
    mock(findAbstractBasic).mockResolvedValue({ id: abstractId, eventId, status: "ACCEPTED" });
    await expectStatus(
      service.assignReviewers(eventId, abstractId, { reviewerIds: ["r1"] }, performedBy),
      409,
    );
    expect(assignReviewersTxn).not.toHaveBeenCalled();
  });

  // 2.9: a decision committed between the read above and the txn's lock.
  it.each([
    ["finalized", 409],
    ["not_found", 404],
  ] as const)("maps the txn's %s refusal to %i without an audit row", async (reason, status) => {
    mock(findActiveMembershipUserIds).mockResolvedValue(["r1", "r2"]);
    mock(assignReviewersTxn).mockResolvedValue({ ok: false, reason });
    await expectStatus(
      service.assignReviewers(eventId, abstractId, { reviewerIds: ["r1", "r2"] }, performedBy),
      status,
    );
    expect(insertAuditLog).not.toHaveBeenCalled();
  });

  // 2.9 follow-up: a member removed between the pre-check and the txn's
  // membership lock gets the same 400 as the pre-check.
  it("maps the txn's inactive_member refusal to the pre-check's 400 without an audit row", async () => {
    mock(findActiveMembershipUserIds).mockResolvedValue(["r1", "r2"]);
    mock(assignReviewersTxn).mockResolvedValue({
      ok: false,
      reason: "inactive_member",
      reviewerIds: ["r2"],
    });
    const err = await service
      .assignReviewers(eventId, abstractId, { reviewerIds: ["r1", "r2"] }, performedBy)
      .catch((e) => e);
    expect(err).toBeInstanceOf(AppException);
    expect((err as AppException).getStatus()).toBe(400);
    expect((err as AppException).getResponse()).toMatchObject({
      code: ErrorCodes.VALIDATION_ERROR,
      message: "All reviewers must have active membership",
    });
    expect(insertAuditLog).not.toHaveBeenCalled();
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

  // Extras follow the divergence alert's rule (scoreDivergence in
  // @app/shared). Before, a zero threshold admitted extras on fewer than two
  // scores or a zero spread, where the alert never fires; those now 400.
  it.each([
    // [divergenceThreshold (null: no config, default 6), active scores, allowed]
    [0, [], false],
    [0, [12], false],
    [0, [12, 12], false],
    [0, [12, 12, 12], false],
    [0, [12, 13], true],
    [1, [12, 12], false],
    [1, [12, 13], true],
    [6, [10, 15], false],
    [6, [10, 16], true],
    [6, [16, 3, 10], true],
    [null, [10, 15], false],
    [null, [10, 16], true],
  ] as const)(
    "extra reviewers at threshold %s with scores %j: allowed=%s",
    async (threshold, scores, allowed) => {
      mock(getReviewerAssignmentConfig).mockResolvedValue(
        threshold === null
          ? null
          : { reviewersPerAbstract: 2, divergenceThreshold: threshold, distributeByTheme: false },
      );
      mock(findScoredReviewScores).mockResolvedValue([...scores]);
      mock(findActiveMembershipUserIds).mockResolvedValue(["r1", "r2", "r3"]);
      mock(assignReviewersTxn).mockResolvedValue({
        ok: true,
        id: abstractId,
        status: "UNDER_REVIEW",
      });

      const result = await service
        .assignReviewers(eventId, abstractId, { reviewerIds: ["r1", "r2", "r3"] }, performedBy)
        .catch((e: unknown) => e);

      if (allowed) {
        expect(result).toEqual({
          abstractId,
          status: "UNDER_REVIEW",
          reviewerIds: ["r1", "r2", "r3"],
        });
      } else {
        expect(result).toBeInstanceOf(AppException);
        expect((result as AppException).getStatus()).toBe(400);
        expect((result as AppException).getResponse()).toMatchObject({
          code: ErrorCodes.VALIDATION_ERROR,
          message: "Extra reviewers can only be assigned after a score divergence alert",
        });
        expect(assignReviewersTxn).not.toHaveBeenCalled();
      }
    },
  );

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

  // L3: distributeByTheme wires up an until-now-dead config flag.
  describe("distributeByTheme", () => {
    it("permits zero-theme-overlap reviewers when distributeByTheme is off (default)", async () => {
      mock(getReviewerAssignmentConfig).mockResolvedValue({
        reviewersPerAbstract: 2,
        divergenceThreshold: 6,
        distributeByTheme: false,
      });
      mock(findActiveMembershipUserIds).mockResolvedValue(["r1", "r2"]);
      mock(assignReviewersTxn).mockResolvedValue({
        ok: true,
        id: abstractId,
        status: "UNDER_REVIEW",
      });

      await service.assignReviewers(
        eventId,
        abstractId,
        { reviewerIds: ["r1", "r2"] },
        performedBy,
      );

      expect(assignReviewersTxn).toHaveBeenCalled();
      expect(findAbstractThemeIds).not.toHaveBeenCalled();
    });

    it("422s naming reviewers with zero theme overlap when distributeByTheme is on", async () => {
      mock(getReviewerAssignmentConfig).mockResolvedValue({
        reviewersPerAbstract: 2,
        divergenceThreshold: 6,
        distributeByTheme: true,
      });
      mock(findActiveMembershipUserIds).mockResolvedValue(["r1", "r2"]);
      mock(findAbstractThemeIds).mockResolvedValue(["theme-1"]);
      mock(listActiveReviewerThemeIds).mockImplementation(
        async (_eventId: string, reviewerId: string) =>
          reviewerId === "r1" ? ["theme-1"] : ["theme-2"],
      );

      const err = await service
        .assignReviewers(
          eventId,
          abstractId,
          { reviewerIds: ["r1", "r2"] },
          performedBy,
        )
        .catch((e) => e);

      expect((err as AppException).getStatus()).toBe(422);
      expect((err as AppException).getResponse()).toMatchObject({
        details: { reviewerIds: ["r2"] },
      });
      expect(assignReviewersTxn).not.toHaveBeenCalled();
    });

    it("succeeds when every reviewer shares a theme with the abstract", async () => {
      mock(getReviewerAssignmentConfig).mockResolvedValue({
        reviewersPerAbstract: 2,
        divergenceThreshold: 6,
        distributeByTheme: true,
      });
      mock(findActiveMembershipUserIds).mockResolvedValue(["r1", "r2"]);
      mock(findAbstractThemeIds).mockResolvedValue(["theme-1"]);
      mock(listActiveReviewerThemeIds).mockResolvedValue(["theme-1"]);
      mock(assignReviewersTxn).mockResolvedValue({
        ok: true,
        id: abstractId,
        status: "UNDER_REVIEW",
      });

      const result = await service.assignReviewers(
        eventId,
        abstractId,
        { reviewerIds: ["r1", "r2"] },
        performedBy,
      );

      expect(result).toEqual({
        abstractId,
        status: "UNDER_REVIEW",
        reviewerIds: ["r1", "r2"],
      });
    });
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
      ok: true,
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

  // H10: a comment during a comments-disabled window must no longer reject
  // the whole submission — the score still saves; the txn (not this service)
  // drops the comment.
  it("saves the score (and forwards the comment to the txn to drop) when comments are disabled", async () => {
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
    mock(reviewAbstractTxn).mockResolvedValue({
      ok: true,
      id: abstractId,
      status: "REVIEW_COMPLETE",
      averageScore: 9,
      reviewCount: 1,
    });

    const result = await service.reviewAssignedAbstract(abstractId, reviewerId, {
      score: 9,
      comment: "should be dropped by the txn, not rejected here",
    });

    expect(result).toMatchObject({ status: "REVIEW_COMPLETE" });
    expect(reviewAbstractTxn).toHaveBeenCalledWith(
      expect.objectContaining({ score: 9, commentsEnabled: false }),
    );
  });

  // H4: scoring requires an ACTIVE explicit review row — theme coverage may
  // grant read access (see "reviewer reads" above) but must never grant
  // scoring, and a deactivated (removed) reviewer cannot self-reinstate.
  it("403s a theme-matching reviewer with no explicit assignment (no txn)", async () => {
    grantActiveMembership();
    mock(findAbstractForReview).mockResolvedValue(forReview({ reviews: [] }));
    await expectStatus(
      service.reviewAssignedAbstract(abstractId, reviewerId, { score: 9 }),
      403,
    );
    expect(reviewAbstractTxn).not.toHaveBeenCalled();
  });

  it("403s a removed (deactivated) reviewer — no self-reinstatement (no txn)", async () => {
    grantActiveMembership();
    mock(findAbstractForReview).mockResolvedValue(
      forReview({ reviews: [{ reviewerId, active: false }] }),
    );
    await expectStatus(
      service.reviewAssignedAbstract(abstractId, reviewerId, { score: 9 }),
      403,
    );
    expect(reviewAbstractTxn).not.toHaveBeenCalled();
  });

  // 2.9: the txn re-checks status and assignment under the abstract's row
  // lock; a decision or removal committed after the checks above maps to the
  // same answers as those checks.
  it.each([
    ["finalized", 409],
    ["not_assigned", 403],
    ["not_found", 404],
  ] as const)("maps the txn's %s refusal to %i", async (reason, status) => {
    grantActiveMembership();
    mock(findAbstractForReview).mockResolvedValue(forReview());
    mock(reviewAbstractTxn).mockResolvedValue({ ok: false, reason });
    await expectStatus(
      service.reviewAssignedAbstract(abstractId, reviewerId, { score: 9 }),
      status,
    );
  });

  it("succeeds for an actively assigned reviewer", async () => {
    grantActiveMembership();
    mock(findAbstractForReview).mockResolvedValue(
      forReview({ reviews: [{ reviewerId, active: true }] }),
    );
    mock(reviewAbstractTxn).mockResolvedValue({
      ok: true,
      id: abstractId,
      status: "REVIEW_COMPLETE",
      averageScore: 9,
      reviewCount: 1,
    });

    const result = await service.reviewAssignedAbstract(abstractId, reviewerId, {
      score: 9,
    });

    expect(result).toMatchObject({ status: "REVIEW_COMPLETE" });
    expect(reviewAbstractTxn).toHaveBeenCalled();
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
    expect(mintCommitteeInviteToken).not.toHaveBeenCalled();
  });

  it("sends the reset email and audit-logs on success", async () => {
    mock(findCommitteeInviteTarget).mockResolvedValue(target);
    mock(mintCommitteeInviteToken).mockResolvedValue("a".repeat(64));
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
        subject: "Nouveau lien d'accès - comité scientifique",
        categories: ["committee-password-reset"],
      }),
    );
    expect(insertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "User",
        action: "admin_reset_password",
        changes: { method: { old: null, new: "invite_token" } },
      }),
      rootDb,
    );
  });

  it("records the password-link email through sendEmailNow on the shared layout, without an invite trigger", async () => {
    mock(findCommitteeInviteTarget).mockResolvedValue(target);
    mock(mintCommitteeInviteToken).mockResolvedValue("a".repeat(64));
    sendEmailMock.mockResolvedValue({ success: true });

    await service.resendCommitteeInvite(eventId, reviewerId, performedBy);

    const [input] = sendEmailNowMock.mock.calls[0]!;
    expect(input).toMatchObject({ to: "r9@example.com", categories: ["committee-password-reset"] });
    expect(input.log).toBeUndefined();
  });

  it("reports false for an unconfirmed (UNCERTAIN) send, still audit-logged", async () => {
    mock(findCommitteeInviteTarget).mockResolvedValue(target);
    mock(mintCommitteeInviteToken).mockResolvedValue("a".repeat(64));
    sendEmailMock.mockRejectedValue(new Error("timeout"));

    const result = await service.resendCommitteeInvite(eventId, reviewerId, performedBy);
    expect(result).toEqual({ inviteEmailSent: false });
    expect(insertAuditLog).toHaveBeenCalled();
  });

  it("reports false but still audit-logs when SendGrid fails", async () => {
    mock(findCommitteeInviteTarget).mockResolvedValue(target);
    mock(mintCommitteeInviteToken).mockResolvedValue("a".repeat(64));
    sendEmailMock.mockResolvedValue({ success: false, error: "down" });

    const result = await service.resendCommitteeInvite(
      eventId,
      reviewerId,
      performedBy,
    );
    expect(result).toEqual({ inviteEmailSent: false });
    expect(insertAuditLog).toHaveBeenCalled();
  });

  it("reports false but still audit-logs when link generation throws", async () => {
    mock(findCommitteeInviteTarget).mockResolvedValue(target);
    mock(mintCommitteeInviteToken).mockRejectedValue(new Error("firebase"));

    const result = await service.resendCommitteeInvite(
      eventId,
      reviewerId,
      performedBy,
    );
    expect(result).toEqual({ inviteEmailSent: false });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(insertAuditLog).toHaveBeenCalled();
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
      service.setCommitteeMemberPassword(
        eventId,
        reviewerId,
        newPassword,
        clientAdminCaller,
      ),
      404,
    );
    expect(updateFirebaseUserPassword).not.toHaveBeenCalled();
  });

  it("sets the password, revokes tokens, and audit-logs without leaking the password", async () => {
    mock(findAbstractMembership).mockResolvedValue({ active: true });
    mock(findCommitteeUserClientIds).mockResolvedValue(["client-1"]);

    const result = await service.setCommitteeMemberPassword(
      eventId,
      reviewerId,
      newPassword,
      clientAdminCaller,
    );

    expect(result).toEqual({ ok: true });
    expect(updateFirebaseUserPassword).toHaveBeenCalledWith(reviewerId, newPassword);
    expect(revokeFirebaseRefreshTokens).toHaveBeenCalledWith(reviewerId);
    const auditArg = mock(insertAuditLog).mock.calls.at(-1)?.[0];
    expect(auditArg).toMatchObject({
      action: "admin_reset_password",
      changes: { method: { old: null, new: "direct" } },
    });
    expect(JSON.stringify(auditArg ?? {})).not.toContain(newPassword);
  });

  // C2: committee accounts are deliberately cross-tenant — forbid resetting a
  // shared reviewer's password unless the caller's own access already covers
  // every client that reviewer holds an active membership under.
  it("403s a client admin when the target also reviews for a different client", async () => {
    mock(findAbstractMembership).mockResolvedValue({ active: true });
    mock(findCommitteeUserClientIds).mockResolvedValue(["client-1", "client-2"]);

    await expectStatus(
      service.setCommitteeMemberPassword(
        eventId,
        reviewerId,
        newPassword,
        clientAdminCaller,
      ),
      403,
    );
    expect(updateFirebaseUserPassword).not.toHaveBeenCalled();
    expect(revokeFirebaseRefreshTokens).not.toHaveBeenCalled();
  });

  it("allows a client admin when the target's memberships are all within their own client (single-tenant)", async () => {
    mock(findAbstractMembership).mockResolvedValue({ active: true });
    mock(findCommitteeUserClientIds).mockResolvedValue(["client-1"]);

    const result = await service.setCommitteeMemberPassword(
      eventId,
      reviewerId,
      newPassword,
      clientAdminCaller,
    );

    expect(result).toEqual({ ok: true });
    expect(updateFirebaseUserPassword).toHaveBeenCalledWith(reviewerId, newPassword);
  });

  it("allows a super-admin caller even when the target spans multiple clients", async () => {
    mock(findAbstractMembership).mockResolvedValue({ active: true });
    mock(findCommitteeUserClientIds).mockResolvedValue(["client-1", "client-2"]);

    const result = await service.setCommitteeMemberPassword(
      eventId,
      reviewerId,
      newPassword,
      superAdminCaller,
    );

    expect(result).toEqual({ ok: true });
    expect(updateFirebaseUserPassword).toHaveBeenCalledWith(reviewerId, newPassword);
  });
});
