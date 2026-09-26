import { Inject, Injectable } from "@nestjs/common";
import { ErrorCodes, UserRole } from "@app/contracts";
import {
  replaceCommitteeInvite,
  insertCommitteeInvite,
  supersedeCommitteeInvite,
  findCommitteeInviteByHash,
  findCommitteeInviteById,
  claimCommitteeInvite,
  releaseCommitteeInvite,
  deleteUnusedCommitteeInvites,
  discardCommitteeInvite,
  findAbstractMembership,
  insertAuditLog,
  getDb,
} from "@app/db";
import {
  updateFirebaseUserPassword,
  revokeFirebaseRefreshTokens,
} from "@app/integrations";
import { CONFIG, type Config } from "../../core/config";
import { AppException } from "../../core/app-exception";
import { logger } from "../../core/logger.service";
import { CommitteeEmailsService } from "./abstracts.committee-emails";
import {
  generateCommitteeInviteToken,
  hashCommitteeInviteToken,
} from "./committee-invite-token";

type Invite = NonNullable<
  Awaited<ReturnType<typeof findCommitteeInviteByHash>>
>;
const invalid = () =>
  new AppException(
    ErrorCodes.COMMITTEE_INVITE_INVALID,
    "This invitation link is not valid",
    410,
  );
const expired = () =>
  new AppException(
    ErrorCodes.COMMITTEE_INVITE_EXPIRED,
    "This invitation link has expired",
    410,
  );
const used = () =>
  new AppException(
    ErrorCodes.COMMITTEE_INVITE_USED,
    "This invitation link has already been used",
    410,
  );

/** Single-use, hashed-at-rest capabilities. Public failures are 410, never 401. */
@Injectable()
export class CommitteeInviteService {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly emails: CommitteeEmailsService,
  ) {}

  buildCommitteeInviteLink(token: string): string {
    return `${this.config.urls.adminAppUrl}/committee/set-password?token=${token}&lang=fr`;
  }

  private tokenData(
    raw: string,
    userId: string,
    eventId: string,
    createdBy: string | null,
  ) {
    return {
      tokenHash: hashCommitteeInviteToken(raw),
      userId,
      eventId,
      createdBy,
      expiresAt: new Date(
        Date.now() +
          this.config.security.committeeInvite.tokenTtlDays * 86_400_000,
      ),
    };
  }

  async mintCommitteeInviteToken(
    userId: string,
    eventId: string,
    createdBy: string | null,
  ): Promise<string> {
    const raw = generateCommitteeInviteToken();
    await replaceCommitteeInvite(
      this.tokenData(raw, userId, eventId, createdBy),
    );
    return raw;
  }

  private async eligible(invite: Invite): Promise<boolean> {
    if (
      !invite.user.active ||
      invite.user.role !== UserRole.SCIENTIFIC_COMMITTEE
    )
      return false;
    return (
      (await findAbstractMembership(invite.eventId, invite.userId))?.active ===
      true
    );
  }

  private async loadUsableInvite(raw: string): Promise<Invite> {
    const invite = await findCommitteeInviteByHash(
      hashCommitteeInviteToken(raw),
    );
    if (!invite) throw invalid();
    if (invite.usedAt) throw used();
    if (invite.expiresAt.getTime() <= Date.now()) throw expired();
    if (!(await this.eligible(invite))) throw invalid();
    return invite;
  }

  async verifyCommitteeInvite(raw: string) {
    const invite = await this.loadUsableInvite(raw);
    return {
      email: invite.user.email,
      name: invite.user.name,
      eventName: invite.event.name,
    };
  }

  private async classifyFailedClaim(id: string): Promise<AppException> {
    const row = await findCommitteeInviteById(id);
    if (!row) return invalid();
    if (row.expiresAt.getTime() <= Date.now()) return expired();
    if (row.usedAt) return used();
    return invalid();
  }

  async setCommitteeMemberPasswordWithInvite(
    raw: string,
    password: string,
  ): Promise<{ ok: true; email: string }> {
    const invite = await this.loadUsableInvite(raw);
    const now = new Date();
    if (!(await claimCommitteeInvite(invite.id, now)))
      throw await this.classifyFailedClaim(invite.id);
    try {
      await updateFirebaseUserPassword(invite.userId, password);
    } catch (err) {
      logger.error(
        { err, userId: invite.userId },
        "Committee invite password update failed",
      );
      try {
        await releaseCommitteeInvite(invite, now);
      } catch (releaseError) {
        logger.error(
          { err: releaseError, inviteId: invite.id },
          "Failed to release committee invite claim",
        );
      }
      throw new AppException(
        ErrorCodes.INTERNAL_ERROR,
        "Could not set the password. Please try again.",
        500,
      );
    }
    // The password has changed. Cleanup/audit failure must never release the
    // capability or turn successful activation into an unretryable failure.
    try {
      await revokeFirebaseRefreshTokens(invite.userId);
    } catch (err) {
      logger.error(
        { err, userId: invite.userId },
        "Failed to revoke refresh tokens after committee invite password set",
      );
    }
    try {
      await deleteUnusedCommitteeInvites(invite.userId, getDb());
    } catch (err) {
      logger.error(
        { err, userId: invite.userId },
        "Failed to purge remaining committee invite tokens after password set",
      );
    }
    try {
      await insertAuditLog({
        entityType: "User",
        entityId: invite.userId,
        action: "invite_password_set",
        changes: { method: { old: null, new: "invite_token" } },
        performedBy: invite.userId,
      }, getDb());
    } catch (err) {
      logger.error({ err }, "Failed to audit committee invite password set");
    }
    return { ok: true, email: invite.user.email };
  }

  private async discardUndeliveredInvite(id: string) {
    try {
      await discardCommitteeInvite(id);
    } catch (err) {
      logger.error(
        { err, inviteId: id },
        "Failed to discard undelivered committee invite",
      );
    }
  }

  /** Deliver first, supersede after success. Stale/unusable tokens are opaque. */
  async resendCommitteeInviteWithToken(raw: string): Promise<{ ok: true }> {
    const invite = await findCommitteeInviteByHash(
      hashCommitteeInviteToken(raw),
    );
    if (!invite || invite.usedAt || !(await this.eligible(invite)))
      return { ok: true };
    let createdId: string | null = null;
    let delivered = false;
    try {
      const token = generateCommitteeInviteToken();
      const created = await insertCommitteeInvite(
        this.tokenData(token, invite.userId, invite.eventId, null),
        getDb(),
      );
      createdId = created.id;
      const sent = await this.emails.sendInviteEmail(
        invite.user,
        invite.event.name,
        this.buildCommitteeInviteLink(token),
        invite.eventId,
      );
      if (!sent) {
        await this.discardUndeliveredInvite(createdId);
        return { ok: true };
      }
      delivered = true;
      await supersedeCommitteeInvite(createdId);
    } catch (err) {
      logger.error(
        { err, userId: invite.userId, eventId: invite.eventId },
        "Committee invite self-resend failed",
      );
      if (createdId && !delivered) await this.discardUndeliveredInvite(createdId);
      return { ok: true };
    }
    try {
      await insertAuditLog({
        entityType: "User",
        entityId: invite.userId,
        action: "invite_resent_self",
        changes: { method: { old: null, new: "invite_token" } },
        performedBy: invite.userId,
      }, getDb());
    } catch (err) {
      logger.error({ err }, "Failed to audit committee invite self-resend");
    }
    return { ok: true };
  }
}
