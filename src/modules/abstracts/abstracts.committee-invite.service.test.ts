/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, it, expect, vi } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import { firebaseAuthMock } from "../../../tests/mocks/firebase.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { UserRole } from "@shared/constants/roles.js";

vi.mock("@shared/utils/audit.js", () => ({
  auditLog: vi.fn(),
}));

const sendEmailMock = vi.fn();
vi.mock("@modules/email/email-sender.service.js", () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...args),
}));

const updateFirebaseUserPasswordMock =
  firebaseAuthMock.updateFirebaseUserPassword;
const revokeFirebaseRefreshTokensMock =
  firebaseAuthMock.revokeFirebaseRefreshTokens;

import { auditLog } from "@shared/utils/audit.js";
import { hashCommitteeInviteToken } from "./committee-invite-token.js";
import {
  buildCommitteeInviteLink,
  mintCommitteeInviteToken,
  resendCommitteeInviteWithToken,
  setCommitteeMemberPasswordWithInvite,
  verifyCommitteeInvite,
} from "./abstracts.committee-invite.service.js";

const eventId = "event-1";
const userId = "committee-user-1";
const rawToken = "a".repeat(64);
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function makeInvite(overrides: Record<string, unknown> = {}) {
  return {
    id: "invite-1",
    tokenHash: hashCommitteeInviteToken(rawToken),
    userId,
    eventId,
    expiresAt: new Date(Date.now() + SEVEN_DAYS_MS),
    usedAt: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    createdBy: "admin-1",
    user: {
      id: userId,
      email: "committee@example.com",
      name: "Committee Member",
      active: true,
      role: UserRole.SCIENTIFIC_COMMITTEE,
    },
    event: { name: "Big Event" },
    ...overrides,
  };
}

function makeInviteUser(overrides: Record<string, unknown> = {}) {
  return {
    id: userId,
    email: "committee@example.com",
    name: "Committee Member",
    active: true,
    role: UserRole.SCIENTIFIC_COMMITTEE,
    ...overrides,
  };
}

function mockActiveMembership(active = true) {
  prismaMock.abstractCommitteeMembership.findUnique.mockResolvedValue({
    active,
  } as any);
}

/**
 * The resend flow reads back the id of the row it just minted so it can
 * supersede the *other* tokens only after delivery succeeds.
 */
function mockMintedRow(id = "invite-2") {
  (prismaMock.committeeInviteToken.create as any).mockResolvedValue({ id });
  return id;
}

describe("committee invite service", () => {
  beforeEach(() => {
    sendEmailMock.mockReset();
    updateFirebaseUserPasswordMock.mockReset();
    revokeFirebaseRefreshTokensMock.mockReset();
    (auditLog as any).mockReset?.();
    (auditLog as any).mockResolvedValue?.(undefined);
  });

  describe("buildCommitteeInviteLink", () => {
    it("points at the admin set-password page with the token and lang", () => {
      expect(buildCommitteeInviteLink(rawToken)).toMatch(
        new RegExp(
          `^https?://[^/]+/committee/set-password\\?token=${rawToken}&lang=fr$`,
        ),
      );
    });
  });

  describe("mintCommitteeInviteToken", () => {
    it("deletes prior unused tokens, stores only the hash, and expires in 7 days", async () => {
      const before = Date.now();
      const token = await mintCommitteeInviteToken(userId, eventId, "admin-1");
      const after = Date.now();

      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(prismaMock.committeeInviteToken.deleteMany).toHaveBeenCalledWith({
        where: { userId, eventId, usedAt: null },
      });
      // Supersede + create must commit together, never half-way.
      const txArg = (prismaMock.$transaction as any).mock.calls[0][0];
      expect(Array.isArray(txArg)).toBe(true);
      expect(txArg).toHaveLength(2);

      const data = (prismaMock.committeeInviteToken.create as any).mock
        .calls[0][0].data;
      expect(data.tokenHash).toBe(hashCommitteeInviteToken(token));
      expect(data.tokenHash).not.toBe(token);
      expect(data.userId).toBe(userId);
      expect(data.eventId).toBe(eventId);
      expect(data.createdBy).toBe("admin-1");
      expect((data.expiresAt as Date).getTime()).toBeGreaterThanOrEqual(
        before + SEVEN_DAYS_MS,
      );
      expect((data.expiresAt as Date).getTime()).toBeLessThanOrEqual(
        after + SEVEN_DAYS_MS,
      );
    });

    it("records a null createdBy for self-service resends", async () => {
      await mintCommitteeInviteToken(userId, eventId, null);
      const data = (prismaMock.committeeInviteToken.create as any).mock
        .calls[0][0].data;
      expect(data.createdBy).toBeNull();
    });
  });

  describe("verifyCommitteeInvite", () => {
    it("returns the invitee details for a live token", async () => {
      prismaMock.committeeInviteToken.findUnique.mockResolvedValue(
        makeInvite() as any,
      );
      mockActiveMembership();

      await expect(verifyCommitteeInvite(rawToken)).resolves.toEqual({
        email: "committee@example.com",
        name: "Committee Member",
        eventName: "Big Event",
      });
      expect(prismaMock.committeeInviteToken.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tokenHash: hashCommitteeInviteToken(rawToken) },
        }),
      );
    });

    it("throws 410 INVALID for an unknown token", async () => {
      prismaMock.committeeInviteToken.findUnique.mockResolvedValue(null);

      await expect(verifyCommitteeInvite(rawToken)).rejects.toMatchObject({
        statusCode: 410,
        code: ErrorCodes.COMMITTEE_INVITE_INVALID,
      });
    });

    it("throws 410 USED for an already-consumed token", async () => {
      prismaMock.committeeInviteToken.findUnique.mockResolvedValue(
        makeInvite({ usedAt: new Date() }) as any,
      );

      await expect(verifyCommitteeInvite(rawToken)).rejects.toMatchObject({
        statusCode: 410,
        code: ErrorCodes.COMMITTEE_INVITE_USED,
      });
    });

    it("throws 410 EXPIRED once the TTL has elapsed", async () => {
      prismaMock.committeeInviteToken.findUnique.mockResolvedValue(
        makeInvite({ expiresAt: new Date(Date.now() - 1000) }) as any,
      );

      await expect(verifyCommitteeInvite(rawToken)).rejects.toMatchObject({
        statusCode: 410,
        code: ErrorCodes.COMMITTEE_INVITE_EXPIRED,
      });
    });

    it("collapses an inactive user into the generic INVALID code", async () => {
      prismaMock.committeeInviteToken.findUnique.mockResolvedValue(
        makeInvite({ user: makeInviteUser({ active: false }) }) as any,
      );

      await expect(verifyCommitteeInvite(rawToken)).rejects.toMatchObject({
        statusCode: 410,
        code: ErrorCodes.COMMITTEE_INVITE_INVALID,
      });
    });

    it.each([
      ["promoted to client admin", UserRole.CLIENT_ADMIN],
      ["promoted to super admin", UserRole.SUPER_ADMIN],
    ])(
      "collapses a user %s into the generic INVALID code",
      async (_label, role) => {
        prismaMock.committeeInviteToken.findUnique.mockResolvedValue(
          makeInvite({ user: makeInviteUser({ role }) }) as any,
        );
        mockActiveMembership();

        await expect(verifyCommitteeInvite(rawToken)).rejects.toMatchObject({
          statusCode: 410,
          code: ErrorCodes.COMMITTEE_INVITE_INVALID,
        });
      },
    );

    it("collapses a missing/inactive membership into the generic INVALID code", async () => {
      prismaMock.committeeInviteToken.findUnique.mockResolvedValue(
        makeInvite() as any,
      );
      mockActiveMembership(false);

      await expect(verifyCommitteeInvite(rawToken)).rejects.toMatchObject({
        statusCode: 410,
        code: ErrorCodes.COMMITTEE_INVITE_INVALID,
      });

      prismaMock.abstractCommitteeMembership.findUnique.mockResolvedValue(null);
      await expect(verifyCommitteeInvite(rawToken)).rejects.toMatchObject({
        statusCode: 410,
        code: ErrorCodes.COMMITTEE_INVITE_INVALID,
      });
    });
  });

  describe("setCommitteeMemberPasswordWithInvite", () => {
    beforeEach(() => {
      prismaMock.committeeInviteToken.findUnique.mockResolvedValue(
        makeInvite() as any,
      );
      mockActiveMembership();
    });

    it("claims the token, sets the Firebase password, revokes sessions and audits", async () => {
      prismaMock.committeeInviteToken.updateMany.mockResolvedValue({
        count: 1,
      } as any);

      await expect(
        setCommitteeMemberPasswordWithInvite(rawToken, "Str0ng!Passw0rd"),
      ).resolves.toEqual({ ok: true, email: "committee@example.com" });

      expect(prismaMock.committeeInviteToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "invite-1",
            usedAt: null,
            expiresAt: { gt: expect.any(Date) },
          }),
          data: { usedAt: expect.any(Date) },
        }),
      );
      expect(updateFirebaseUserPasswordMock).toHaveBeenCalledWith(
        userId,
        "Str0ng!Passw0rd",
      );
      expect(revokeFirebaseRefreshTokensMock).toHaveBeenCalledWith(userId);
      expect(auditLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          entityType: "User",
          entityId: userId,
          action: "invite_password_set",
          changes: { method: { old: null, new: "invite_token" } },
        }),
      );
    });

    it("purges the member's other unused tokens once a password exists", async () => {
      prismaMock.committeeInviteToken.updateMany.mockResolvedValue({
        count: 1,
      } as any);

      await setCommitteeMemberPasswordWithInvite(rawToken, "Str0ng!Passw0rd");

      // Event-wide: the just-claimed row has usedAt set, so it survives.
      expect(prismaMock.committeeInviteToken.deleteMany).toHaveBeenCalledWith({
        where: { userId, usedAt: null },
      });
    });

    it("still succeeds when revoking refresh tokens fails, without un-claiming", async () => {
      prismaMock.committeeInviteToken.updateMany.mockResolvedValue({
        count: 1,
      } as any);
      revokeFirebaseRefreshTokensMock.mockRejectedValue(
        new Error("firebase flaky"),
      );

      await expect(
        setCommitteeMemberPasswordWithInvite(rawToken, "Str0ng!Passw0rd"),
      ).resolves.toEqual({ ok: true, email: "committee@example.com" });

      // Only the claim wrote to the row — no compensating un-claim.
      expect(prismaMock.committeeInviteToken.updateMany).toHaveBeenCalledTimes(
        1,
      );
      expect(auditLog).toHaveBeenCalled();
    });

    it("still succeeds when the audit write fails", async () => {
      prismaMock.committeeInviteToken.updateMany.mockResolvedValue({
        count: 1,
      } as any);
      (auditLog as any).mockRejectedValue(new Error("audit table down"));

      await expect(
        setCommitteeMemberPasswordWithInvite(rawToken, "Str0ng!Passw0rd"),
      ).resolves.toEqual({ ok: true, email: "committee@example.com" });
    });

    // The row as it looks when we re-read it after the claim matched 0 rows.
    const claimRaceCases: [string, unknown, string][] = [
      [
        "already used",
        makeInvite({ usedAt: new Date() }),
        ErrorCodes.COMMITTEE_INVITE_USED,
      ],
      [
        "expired between the load and the claim",
        makeInvite({ expiresAt: new Date(Date.now() - 1000) }),
        ErrorCodes.COMMITTEE_INVITE_EXPIRED,
      ],
      ["superseded and gone", null, ErrorCodes.COMMITTEE_INVITE_INVALID],
    ];

    it.each(claimRaceCases)(
      "re-classifies a 0-row claim as %s instead of always reporting USED",
      async (_label, currentRow, expectedCode) => {
        prismaMock.committeeInviteToken.findUnique
          .mockReset()
          .mockResolvedValueOnce(makeInvite() as any)
          .mockResolvedValueOnce(currentRow as any);
        prismaMock.committeeInviteToken.updateMany.mockResolvedValue({
          count: 0,
        } as any);

        await expect(
          setCommitteeMemberPasswordWithInvite(rawToken, "Str0ng!Passw0rd"),
        ).rejects.toMatchObject({ statusCode: 410, code: expectedCode });

        expect(updateFirebaseUserPasswordMock).not.toHaveBeenCalled();
        expect(revokeFirebaseRefreshTokensMock).not.toHaveBeenCalled();
        expect(auditLog).not.toHaveBeenCalled();
      },
    );

    it("un-claims the token and throws 500 when Firebase rejects the password", async () => {
      prismaMock.committeeInviteToken.updateMany.mockResolvedValue({
        count: 1,
      } as any);
      updateFirebaseUserPasswordMock.mockRejectedValue(
        new Error("firebase down"),
      );

      await expect(
        setCommitteeMemberPasswordWithInvite(rawToken, "Str0ng!Passw0rd"),
      ).rejects.toMatchObject({ statusCode: 500 });

      const unclaim = (
        prismaMock.committeeInviteToken.updateMany as any
      ).mock.calls.at(-1)[0];
      expect(unclaim.data).toEqual({ usedAt: null });
      expect(unclaim.where.id).toBe("invite-1");
      expect(auditLog).not.toHaveBeenCalled();
    });

    it("deletes rather than resurrects a claim that was superseded mid-flight", async () => {
      prismaMock.committeeInviteToken.updateMany.mockResolvedValue({
        count: 1,
      } as any);
      updateFirebaseUserPasswordMock.mockRejectedValue(
        new Error("firebase down"),
      );
      // A resend minted a replacement while we were talking to Firebase.
      prismaMock.committeeInviteToken.findFirst.mockResolvedValue({
        id: "invite-2",
      } as any);

      await expect(
        setCommitteeMemberPasswordWithInvite(rawToken, "Str0ng!Passw0rd"),
      ).rejects.toMatchObject({ statusCode: 500 });

      const deleteArgs = (
        prismaMock.committeeInviteToken.deleteMany as any
      ).mock.calls.at(-1)[0];
      expect(deleteArgs.where.id).toBe("invite-1");
      expect(deleteArgs.where.usedAt).toBeInstanceOf(Date);
      // The claim itself is the only updateMany — nothing was un-claimed.
      expect(prismaMock.committeeInviteToken.updateMany).toHaveBeenCalledTimes(
        1,
      );
    });

    it("refuses an expired token before claiming anything", async () => {
      prismaMock.committeeInviteToken.findUnique.mockResolvedValue(
        makeInvite({ expiresAt: new Date(Date.now() - 1000) }) as any,
      );

      await expect(
        setCommitteeMemberPasswordWithInvite(rawToken, "Str0ng!Passw0rd"),
      ).rejects.toMatchObject({
        statusCode: 410,
        code: ErrorCodes.COMMITTEE_INVITE_EXPIRED,
      });
      expect(prismaMock.committeeInviteToken.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("resendCommitteeInviteWithToken", () => {
    it("mints a new token and emails it for an expired-but-unused token", async () => {
      prismaMock.committeeInviteToken.findUnique.mockResolvedValue(
        makeInvite({ expiresAt: new Date(Date.now() - 1000) }) as any,
      );
      mockActiveMembership();
      const newRowId = mockMintedRow();
      sendEmailMock.mockResolvedValue({ success: true });

      await expect(resendCommitteeInviteWithToken(rawToken)).resolves.toEqual({
        ok: true,
      });

      expect(prismaMock.committeeInviteToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId, eventId, createdBy: null }),
        select: { id: true },
      });
      // Old links only die once delivery is confirmed, and never the new row.
      expect(prismaMock.committeeInviteToken.deleteMany).toHaveBeenCalledWith({
        where: { userId, eventId, usedAt: null, id: { not: newRowId } },
      });
      const sent = sendEmailMock.mock.calls.at(-1)?.[0];
      expect(sent).toMatchObject({
        to: "committee@example.com",
        categories: ["committee-invite"],
      });
      expect(sent.html).toContain("/committee/set-password?token=");
      expect(auditLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          entityType: "User",
          entityId: userId,
          action: "invite_resent_self",
        }),
      );
    });

    it("returns ok without emailing for an unknown token", async () => {
      prismaMock.committeeInviteToken.findUnique.mockResolvedValue(null);

      await expect(resendCommitteeInviteWithToken(rawToken)).resolves.toEqual({
        ok: true,
      });
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(prismaMock.committeeInviteToken.create).not.toHaveBeenCalled();
    });

    it("returns ok without emailing for an already-used token", async () => {
      prismaMock.committeeInviteToken.findUnique.mockResolvedValue(
        makeInvite({ usedAt: new Date() }) as any,
      );

      await expect(resendCommitteeInviteWithToken(rawToken)).resolves.toEqual({
        ok: true,
      });
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it("returns ok without emailing when the membership is inactive", async () => {
      prismaMock.committeeInviteToken.findUnique.mockResolvedValue(
        makeInvite() as any,
      );
      mockActiveMembership(false);

      await expect(resendCommitteeInviteWithToken(rawToken)).resolves.toEqual({
        ok: true,
      });
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(prismaMock.committeeInviteToken.create).not.toHaveBeenCalled();
    });

    it.each([
      ["the user account is inactive", makeInviteUser({ active: false })],
      [
        "the user no longer holds the committee role",
        makeInviteUser({ role: UserRole.CLIENT_ADMIN }),
      ],
    ])("returns ok without emailing when %s", async (_label, user) => {
      prismaMock.committeeInviteToken.findUnique.mockResolvedValue(
        makeInvite({ user }) as any,
      );
      mockActiveMembership();

      await expect(resendCommitteeInviteWithToken(rawToken)).resolves.toEqual({
        ok: true,
      });
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(prismaMock.committeeInviteToken.create).not.toHaveBeenCalled();
    });

    it("keeps the old token and drops the new row when the email provider fails", async () => {
      prismaMock.committeeInviteToken.findUnique.mockResolvedValue(
        makeInvite() as any,
      );
      mockActiveMembership();
      const newRowId = mockMintedRow();
      sendEmailMock.mockResolvedValue({ success: false, error: "smtp down" });

      await expect(resendCommitteeInviteWithToken(rawToken)).resolves.toEqual({
        ok: true,
      });

      // Only the undelivered row is removed — the member can still use the
      // link they already have.
      expect(prismaMock.committeeInviteToken.deleteMany).toHaveBeenCalledTimes(
        1,
      );
      expect(prismaMock.committeeInviteToken.deleteMany).toHaveBeenCalledWith({
        where: { id: newRowId, usedAt: null },
      });
      expect(auditLog).not.toHaveBeenCalled();
    });

    it("keeps the old token and drops the new row when sending throws", async () => {
      prismaMock.committeeInviteToken.findUnique.mockResolvedValue(
        makeInvite() as any,
      );
      mockActiveMembership();
      const newRowId = mockMintedRow();
      sendEmailMock.mockRejectedValue(new Error("sendgrid exploded"));

      await expect(resendCommitteeInviteWithToken(rawToken)).resolves.toEqual({
        ok: true,
      });

      expect(prismaMock.committeeInviteToken.deleteMany).toHaveBeenCalledTimes(
        1,
      );
      expect(prismaMock.committeeInviteToken.deleteMany).toHaveBeenCalledWith({
        where: { id: newRowId, usedAt: null },
      });
    });

    it("still returns ok when minting throws, without touching the old token", async () => {
      prismaMock.committeeInviteToken.findUnique.mockResolvedValue(
        makeInvite() as any,
      );
      mockActiveMembership();
      (prismaMock.committeeInviteToken.create as any).mockRejectedValue(
        new Error("db down"),
      );

      await expect(resendCommitteeInviteWithToken(rawToken)).resolves.toEqual({
        ok: true,
      });
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(prismaMock.committeeInviteToken.deleteMany).not.toHaveBeenCalled();
    });
  });
});
