import { prisma } from "@/database/client.js";
import { config } from "@config/app.config.js";
import { UserRole } from "@shared/constants/roles.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import {
  revokeFirebaseRefreshTokens,
  updateFirebaseUserPassword,
} from "@shared/services/firebase.service.js";
import { auditLog } from "@shared/utils/audit.js";
import { logger } from "@shared/utils/logger.js";
import { sendInviteEmail } from "./abstracts.committee-emails.js";
import {
  generateCommitteeInviteToken,
  hashCommitteeInviteToken,
} from "./committee-invite-token.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * App-managed committee invite tokens.
 *
 * Replaces the Firebase-issued password-reset links (whose oobCodes die after
 * one hour) with a single-use token we mint, hash at rest and expire after
 * `COMMITTEE_INVITE_TOKEN_TTL_DAYS`. Dead links surface as HTTP 410 with a
 * distinct code so the admin app can explain *why* — never 401, which the
 * admin ky client turns into a forced sign-out.
 */

function invalidInviteError(): AppError {
  return new AppError(
    "This invitation link is not valid",
    410,
    ErrorCodes.COMMITTEE_INVITE_INVALID,
  );
}

function expiredInviteError(): AppError {
  return new AppError(
    "This invitation link has expired",
    410,
    ErrorCodes.COMMITTEE_INVITE_EXPIRED,
  );
}

function usedInviteError(): AppError {
  return new AppError(
    "This invitation link has already been used",
    410,
    ErrorCodes.COMMITTEE_INVITE_USED,
  );
}

/**
 * Public admin-app page that consumes the token. `lang=fr` because every
 * committee email is French; the page falls back gracefully for other values.
 */
export function buildCommitteeInviteLink(token: string): string {
  return `${config.urls.adminAppUrl}/committee/set-password?token=${token}&lang=fr`;
}

function buildInviteTokenData(
  rawToken: string,
  userId: string,
  eventId: string,
  createdBy: string | null,
) {
  return {
    tokenHash: hashCommitteeInviteToken(rawToken),
    userId,
    eventId,
    expiresAt: new Date(
      Date.now() + config.security.committeeInvite.tokenTtlDays * MS_PER_DAY,
    ),
    createdBy,
  };
}

/**
 * Mint a fresh invite token for a committee membership and return the raw
 * value (the only time it exists outside the recipient's mailbox).
 *
 * Prior *unused* tokens for the same (user, event) are deleted rather than
 * marked used, so `usedAt` keeps the single meaning "consumed by the invitee".
 * Both statements run in one transaction: a failure between them would
 * otherwise commit the supersede while losing the replacement, leaving the
 * member with no usable link at all.
 */
export async function mintCommitteeInviteToken(
  userId: string,
  eventId: string,
  createdBy: string | null,
): Promise<string> {
  const rawToken = generateCommitteeInviteToken();

  await prisma.$transaction([
    prisma.committeeInviteToken.deleteMany({
      where: { userId, eventId, usedAt: null },
    }),
    prisma.committeeInviteToken.create({
      data: buildInviteTokenData(rawToken, userId, eventId, createdBy),
    }),
  ]);

  return rawToken;
}

async function findInviteByToken(rawToken: string) {
  return prisma.committeeInviteToken.findUnique({
    where: { tokenHash: hashCommitteeInviteToken(rawToken) },
    include: {
      user: {
        select: { id: true, email: true, name: true, active: true, role: true },
      },
      event: { select: { name: true } },
    },
  });
}

type InviteWithRelations = NonNullable<
  Awaited<ReturnType<typeof findInviteByToken>>
>;

/**
 * Membership and account state are folded into the generic "invalid" code on
 * purpose: an anonymous caller must not learn whether an address exists, was
 * deactivated, or was removed from the committee.
 */
async function hasActiveCommitteeMembership(
  userId: string,
  eventId: string,
): Promise<boolean> {
  const membership = await prisma.abstractCommitteeMembership.findUnique({
    where: { userId_eventId: { userId, eventId } },
    select: { active: true },
  });
  return membership?.active === true;
}

/**
 * A token is a live credential-setting capability, so it must die with any
 * account-security event: deactivation, or a role change away from the
 * scientific committee (e.g. the account was repurposed as an admin). Both
 * collapse into the generic INVALID code — no state disclosure.
 */
function isEligibleInviteUser(user: InviteWithRelations["user"]): boolean {
  return user.active && user.role === UserRole.SCIENTIFIC_COMMITTEE;
}

async function loadUsableInvite(
  rawToken: string,
): Promise<InviteWithRelations> {
  const invite = await findInviteByToken(rawToken);
  if (!invite) throw invalidInviteError();
  if (invite.usedAt) throw usedInviteError();
  if (invite.expiresAt.getTime() <= Date.now()) throw expiredInviteError();
  if (!isEligibleInviteUser(invite.user)) throw invalidInviteError();
  if (!(await hasActiveCommitteeMembership(invite.userId, invite.eventId))) {
    throw invalidInviteError();
  }
  return invite;
}

/**
 * Resolve an invite token into the details the set-password page renders.
 */
export async function verifyCommitteeInvite(rawToken: string): Promise<{
  email: string;
  name: string;
  eventName: string;
}> {
  const invite = await loadUsableInvite(rawToken);
  return {
    email: invite.user.email,
    name: invite.user.name,
    eventName: invite.event.name,
  };
}

/**
 * Explain a claim that matched zero rows. The pre-flight checks passed, so the
 * row changed underneath us: it was superseded (deleted), expired between the
 * two statements, or another submission won the race.
 */
async function classifyFailedClaim(inviteId: string): Promise<AppError> {
  const row = await prisma.committeeInviteToken.findUnique({
    where: { id: inviteId },
    select: { expiresAt: true, usedAt: true },
  });
  if (!row) return invalidInviteError();
  if (row.expiresAt.getTime() <= Date.now()) return expiredInviteError();
  if (row.usedAt) return usedInviteError();
  // Live and unclaimed yet the update matched nothing — treat as unusable
  // rather than asserting a state we cannot prove.
  return invalidInviteError();
}

/**
 * Best-effort compensation after Firebase rejected the password change.
 *
 * Un-claiming is only safe while this row is still the member's *current*
 * link. If a resend minted a replacement while we were talking to Firebase,
 * restoring `usedAt: null` would resurrect a superseded link — so the claimed
 * row is deleted instead. The check and the write share one transaction.
 */
async function releaseClaimedInvite(
  invite: Pick<InviteWithRelations, "id" | "userId" | "eventId">,
  claimedAt: Date,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const superseder = await tx.committeeInviteToken.findFirst({
        where: {
          userId: invite.userId,
          eventId: invite.eventId,
          usedAt: null,
          id: { not: invite.id },
        },
        select: { id: true },
      });
      if (superseder) {
        await tx.committeeInviteToken.deleteMany({
          where: { id: invite.id, usedAt: claimedAt },
        });
        return;
      }
      await tx.committeeInviteToken.updateMany({
        where: { id: invite.id, usedAt: claimedAt },
        data: { usedAt: null },
      });
    });
  } catch (err) {
    logger.error(
      { err, inviteId: invite.id },
      "Failed to release committee invite token after password update error",
    );
  }
}

/**
 * Consume an invite token and set the member's Firebase password.
 *
 * The claim is a conditional `updateMany` so two concurrent submissions cannot
 * both win; if Firebase then rejects the password change we release the claimed
 * row (see {@link releaseClaimedInvite}) so the link stays usable.
 */
export async function setCommitteeMemberPasswordWithInvite(
  rawToken: string,
  password: string,
): Promise<{ ok: true; email: string }> {
  const invite = await loadUsableInvite(rawToken);
  const now = new Date();

  const claim = await prisma.committeeInviteToken.updateMany({
    where: { id: invite.id, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (claim.count !== 1) throw await classifyFailedClaim(invite.id);

  try {
    // User.id is the Firebase Auth UID.
    await updateFirebaseUserPassword(invite.userId, password);
  } catch (err) {
    logger.error(
      { err, userId: invite.userId, eventId: invite.eventId },
      "Committee invite password update failed — releasing the claimed token",
    );
    await releaseClaimedInvite(invite, now);
    throw new AppError(
      "Could not set the password. Please try again.",
      500,
      ErrorCodes.INTERNAL_ERROR,
    );
  }

  // The credential change already landed; revocation is defence-in-depth only.
  // Failing it must not un-claim the token or fail the activation.
  try {
    await revokeFirebaseRefreshTokens(invite.userId);
  } catch (err) {
    logger.error(
      { err, userId: invite.userId, eventId: invite.eventId },
      "Failed to revoke refresh tokens after committee invite password set",
    );
  }

  // A password now exists for this account, so no credential-setting link may
  // survive anywhere — including invites for other events. The row we just
  // claimed has `usedAt` set and is therefore untouched.
  try {
    await prisma.committeeInviteToken.deleteMany({
      where: { userId: invite.userId, usedAt: null },
    });
  } catch (err) {
    logger.error(
      { err, userId: invite.userId },
      "Failed to purge remaining committee invite tokens after password set",
    );
  }

  // Audit last and guarded: the password is already set, so a logging failure
  // must not turn a successful activation into a 500 the member cannot retry.
  try {
    await auditLog(prisma, {
      entityType: "User",
      entityId: invite.userId,
      action: "invite_password_set",
      changes: { method: { old: null, new: "invite_token" } },
      performedBy: invite.userId,
    });
  } catch (err) {
    logger.error({ err }, "Failed to audit committee invite password set");
  }

  return { ok: true, email: invite.user.email };
}

async function discardUndeliveredInvite(
  inviteId: string,
  context: { userId: string; eventId: string },
): Promise<void> {
  try {
    await prisma.committeeInviteToken.deleteMany({
      where: { id: inviteId, usedAt: null },
    });
  } catch (err) {
    logger.error(
      { err, ...context, inviteId },
      "Failed to discard the undelivered committee invite token",
    );
  }
}

/**
 * Self-service resend from the expired-link page.
 *
 * Always resolves `{ ok: true }` — an anonymous caller holding a stale token
 * must not be able to tell whether it maps to a real, still-eligible member.
 *
 * The new token is minted *before* the old one is superseded and the supersede
 * only runs once delivery is confirmed: deleting first would strand the member
 * with no working link whenever SendGrid is down.
 */
export async function resendCommitteeInviteWithToken(
  rawToken: string,
): Promise<{ ok: true }> {
  const invite = await findInviteByToken(rawToken);
  if (!invite || invite.usedAt || !isEligibleInviteUser(invite.user)) {
    logger.debug(
      { found: Boolean(invite) },
      "Committee invite self-resend ignored for an unusable token",
    );
    return { ok: true };
  }
  if (!(await hasActiveCommitteeMembership(invite.userId, invite.eventId))) {
    logger.debug(
      { userId: invite.userId, eventId: invite.eventId },
      "Committee invite self-resend ignored — membership is missing or inactive",
    );
    return { ok: true };
  }

  const context = { userId: invite.userId, eventId: invite.eventId };
  let createdId: string | null = null;
  try {
    const newRawToken = generateCommitteeInviteToken();
    const created = await prisma.committeeInviteToken.create({
      data: buildInviteTokenData(
        newRawToken,
        invite.userId,
        invite.eventId,
        null,
      ),
      select: { id: true },
    });
    createdId = created.id;

    const sent = await sendInviteEmail(
      invite.user,
      invite.event.name,
      buildCommitteeInviteLink(newRawToken),
    );
    if (!sent) {
      logger.error(
        context,
        "Committee invite self-resend could not be delivered — keeping the previous token",
      );
      await discardUndeliveredInvite(createdId, context);
      return { ok: true };
    }

    // Delivered: only now do the older links stop working.
    await prisma.committeeInviteToken.deleteMany({
      where: {
        userId: invite.userId,
        eventId: invite.eventId,
        usedAt: null,
        id: { not: createdId },
      },
    });
  } catch (err) {
    logger.error(
      { err, ...context },
      "Committee invite self-resend threw while minting or sending",
    );
    if (createdId) await discardUndeliveredInvite(createdId, context);
    return { ok: true };
  }

  try {
    await auditLog(prisma, {
      entityType: "User",
      entityId: invite.userId,
      action: "invite_resent_self",
      changes: { method: { old: null, new: "invite_token" } },
      performedBy: invite.userId,
    });
  } catch (err) {
    logger.error({ err }, "Failed to audit committee invite self-resend");
  }

  return { ok: true };
}
