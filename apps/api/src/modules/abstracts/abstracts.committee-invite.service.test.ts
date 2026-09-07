import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes, UserRole } from "@app/contracts";
vi.mock("@app/db", () => ({
  replaceCommitteeInvite: vi.fn(),
  insertCommitteeInvite: vi.fn(),
  supersedeCommitteeInvite: vi.fn(),
  findCommitteeInviteByHash: vi.fn(),
  findCommitteeInviteById: vi.fn(),
  claimCommitteeInvite: vi.fn(),
  releaseCommitteeInvite: vi.fn(),
  deleteUnusedCommitteeInvites: vi.fn(),
  discardCommitteeInvite: vi.fn(),
  findAbstractMembership: vi.fn(),
  insertAuditLog: vi.fn(),
}));
vi.mock("@app/integrations", () => ({
  updateFirebaseUserPassword: vi.fn(),
  revokeFirebaseRefreshTokens: vi.fn(),
}));
vi.mock("../../core/logger.service", () => ({ logger: { error: vi.fn() } }));
import * as db from "@app/db";
import {
  updateFirebaseUserPassword,
  revokeFirebaseRefreshTokens,
} from "@app/integrations";
import { CommitteeInviteService } from "./abstracts.committee-invite.service";
import { hashCommitteeInviteToken } from "./committee-invite-token";
import type { Config } from "../../core/config";
import type { CommitteeEmailsService } from "./abstracts.committee-emails";

const config = {
  urls: { adminAppUrl: "https://admin.example" },
  security: { committeeInvite: { tokenTtlDays: 7 } },
} as Config;
const emails = { sendInviteEmail: vi.fn() };
const service = new CommitteeInviteService(
  config,
  emails as unknown as CommitteeEmailsService,
);
const raw = "a".repeat(64);
const invite = () => ({
  id: "invite",
  userId: "user",
  eventId: "event",
  tokenHash: hashCommitteeInviteToken(raw),
  usedAt: null,
  expiresAt: new Date(Date.now() + 86400000),
  createdAt: new Date(),
  createdBy: null,
  user: {
    id: "user",
    email: "reviewer@example.com",
    name: "Reviewer",
    active: true,
    role: UserRole.SCIENTIFIC_COMMITTEE,
  },
  event: { name: "Congress" },
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(db.findCommitteeInviteByHash).mockResolvedValue(invite());
  vi.mocked(db.findAbstractMembership).mockResolvedValue({
    active: true,
  } as never);
  vi.mocked(db.claimCommitteeInvite).mockResolvedValue(true);
  vi.mocked(db.insertCommitteeInvite).mockResolvedValue({ id: "new" } as never);
  emails.sendInviteEmail.mockResolvedValue(true);
});
describe("committee invite lifecycle", () => {
  it("mints random tokens, stores only hashes, and uses the configured TTL", async () => {
    const before = Date.now();
    const token = await service.mintCommitteeInviteToken(
      "user",
      "event",
      "admin",
    );
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const data = vi.mocked(db.replaceCommitteeInvite).mock.calls[0][0];
    expect(data).toMatchObject({
      tokenHash: hashCommitteeInviteToken(token),
      userId: "user",
      eventId: "event",
      createdBy: "admin",
    });
    expect(data.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + 7 * 86400000,
    );
    expect(JSON.stringify(data)).not.toContain(token);
    expect(service.buildCommitteeInviteLink(token)).toBe(
      `https://admin.example/committee/set-password?token=${token}&lang=fr`,
    );
  });
  it("returns only the page's identity fields on verify", async () => {
    expect(await service.verifyCommitteeInvite(raw)).toEqual({
      email: "reviewer@example.com",
      name: "Reviewer",
      eventName: "Congress",
    });
    expect(db.findCommitteeInviteByHash).toHaveBeenCalledWith(
      hashCommitteeInviteToken(raw),
    );
  });
  it.each([
    ["missing", null, ErrorCodes.COMMITTEE_INVITE_INVALID],
    [
      "used",
      { ...invite(), usedAt: new Date() },
      ErrorCodes.COMMITTEE_INVITE_USED,
    ],
    [
      "expired",
      { ...invite(), expiresAt: new Date(0) },
      ErrorCodes.COMMITTEE_INVITE_EXPIRED,
    ],
    [
      "disabled",
      { ...invite(), user: { ...invite().user, active: false } },
      ErrorCodes.COMMITTEE_INVITE_INVALID,
    ],
    [
      "role changed",
      { ...invite(), user: { ...invite().user, role: UserRole.CLIENT_ADMIN } },
      ErrorCodes.COMMITTEE_INVITE_INVALID,
    ],
  ] as const)("rejects %s links with 410", async (_name, row, code) => {
    vi.mocked(db.findCommitteeInviteByHash).mockResolvedValue(row);
    await expect(service.verifyCommitteeInvite(raw)).rejects.toMatchObject({
      statusCode: 410,
      code,
    });
  });
  it("invalidates links when membership is removed", async () => {
    vi.mocked(db.findAbstractMembership).mockResolvedValue(null);
    await expect(
      service.setCommitteeMemberPasswordWithInvite(raw, "Secret1!"),
    ).rejects.toMatchObject({ code: ErrorCodes.COMMITTEE_INVITE_INVALID });
    expect(updateFirebaseUserPassword).not.toHaveBeenCalled();
  });
  it("only the winning claimant can change the password", async () => {
    vi.mocked(db.claimCommitteeInvite).mockResolvedValue(false);
    vi.mocked(db.findCommitteeInviteById).mockResolvedValue({
      ...invite(),
      usedAt: new Date(),
    });
    await expect(
      service.setCommitteeMemberPasswordWithInvite(raw, "Secret1!"),
    ).rejects.toMatchObject({ code: ErrorCodes.COMMITTEE_INVITE_USED });
    expect(updateFirebaseUserPassword).not.toHaveBeenCalled();
  });
  it("releases the claim after a failed Firebase password update", async () => {
    vi.mocked(updateFirebaseUserPassword).mockRejectedValue(
      new Error("unavailable"),
    );
    await expect(
      service.setCommitteeMemberPasswordWithInvite(raw, "Secret1!"),
    ).rejects.toMatchObject({ statusCode: 500 });
    expect(db.releaseCommitteeInvite).toHaveBeenCalledWith(
      expect.objectContaining({ id: "invite" }),
      expect.any(Date),
    );
    expect(db.deleteUnusedCommitteeInvites).not.toHaveBeenCalled();
  });
  it("purges all event links after password success and never audits the password", async () => {
    expect(
      await service.setCommitteeMemberPasswordWithInvite(raw, "Secret1!"),
    ).toEqual({ ok: true, email: "reviewer@example.com" });
    expect(updateFirebaseUserPassword).toHaveBeenCalledWith("user", "Secret1!");
    expect(db.deleteUnusedCommitteeInvites).toHaveBeenCalledWith("user");
    expect(
      JSON.stringify(vi.mocked(db.insertAuditLog).mock.calls),
    ).not.toContain("Secret1!");
  });
  it("keeps activation successful when revocation, cleanup or auditing fail", async () => {
    vi.mocked(revokeFirebaseRefreshTokens).mockRejectedValue(
      new Error("offline"),
    );
    vi.mocked(db.deleteUnusedCommitteeInvites).mockRejectedValue(
      new Error("offline"),
    );
    vi.mocked(db.insertAuditLog).mockRejectedValue(new Error("offline"));
    await expect(
      service.setCommitteeMemberPasswordWithInvite(raw, "Secret1!"),
    ).resolves.toMatchObject({ ok: true });
    expect(db.releaseCommitteeInvite).not.toHaveBeenCalled();
  });
  it("resends expired links, then supersedes only after delivery", async () => {
    vi.mocked(db.findCommitteeInviteByHash).mockResolvedValue({
      ...invite(),
      expiresAt: new Date(0),
    });
    await expect(service.resendCommitteeInviteWithToken(raw)).resolves.toEqual({
      ok: true,
    });
    expect(db.supersedeCommitteeInvite).toHaveBeenCalledWith("new");
    expect(emails.sendInviteEmail.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(db.supersedeCommitteeInvite).mock.invocationCallOrder[0],
    );
  });
  it("keeps a delivered link when supersession fails", async () => {
    vi.mocked(db.supersedeCommitteeInvite).mockRejectedValue(new Error("database unavailable"));
    await expect(service.resendCommitteeInviteWithToken(raw)).resolves.toEqual({ ok: true });
    expect(db.discardCommitteeInvite).not.toHaveBeenCalled();
  });
  it.each([false, new Error("provider down")])(
    "preserves the previous link after delivery failure (%s)",
    async (failure) => {
      if (failure instanceof Error)
        emails.sendInviteEmail.mockRejectedValue(failure);
      else emails.sendInviteEmail.mockResolvedValue(failure);
      await expect(
        service.resendCommitteeInviteWithToken(raw),
      ).resolves.toEqual({ ok: true });
      expect(db.discardCommitteeInvite).toHaveBeenCalledWith("new");
      expect(db.deleteUnusedCommitteeInvites).not.toHaveBeenCalled();
    },
  );
  it.each([null, { ...invite(), usedAt: new Date() }])(
    "does not disclose or resend unusable tokens",
    async (row) => {
      vi.mocked(db.findCommitteeInviteByHash).mockResolvedValue(row);
      await expect(
        service.resendCommitteeInviteWithToken(raw),
      ).resolves.toEqual({ ok: true });
      expect(db.insertCommitteeInvite).not.toHaveBeenCalled();
      expect(emails.sendInviteEmail).not.toHaveBeenCalled();
    },
  );
});
