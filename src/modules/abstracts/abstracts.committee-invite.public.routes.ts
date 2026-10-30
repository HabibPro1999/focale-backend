import { publicRateLimits } from "@core/plugins.js";
import {
  CommitteeInviteResendSchema,
  CommitteeInviteSetPasswordSchema,
  CommitteeInviteVerifySchema,
  type CommitteeInviteResendInput,
  type CommitteeInviteSetPasswordInput,
  type CommitteeInviteVerifyInput,
} from "./abstracts.schema.js";
import {
  resendCommitteeInviteWithToken,
  setCommitteeMemberPasswordWithInvite,
  verifyCommitteeInvite,
} from "./abstracts.committee-invite.service.js";
import type { AppInstance } from "@shared/types/fastify.js";

// ============================================================================
// Public Committee Invite Routes (No Auth - single-use emailed token)
// ============================================================================
//
// Deliberately auth-free: no onRequest hooks, and any stray Authorization
// header is ignored. These endpoints must NEVER answer 401 — the admin app's
// ky client force-signs-out on any 401, which would kick a logged-in admin out
// of their session just for opening someone's invite link. Bad tokens are 400
// (Zod) and dead tokens are 410 with a COMMITTEE_INVITE_* code.

export async function committeeInvitePublicRoutes(
  app: AppInstance,
): Promise<void> {
  // POST /api/public/committee/invite/verify
  //
  // A POST with the token in the body, not a GET query param: query strings are
  // written to access/proxy logs and leak through the Referer header, and this
  // token is a live credential-setting capability.
  app.post<{
    Body: CommitteeInviteVerifyInput;
  }>(
    "/committee/invite/verify",
    {
      config: {
        rateLimit: publicRateLimits.committeeInviteVerify,
      },
      schema: {
        body: CommitteeInviteVerifySchema,
      },
    },
    async (request, reply) => {
      const result = await verifyCommitteeInvite(request.body.token);
      return reply.send(result);
    },
  );

  // POST /api/public/committee/invite/set-password
  app.post<{
    Body: CommitteeInviteSetPasswordInput;
  }>(
    "/committee/invite/set-password",
    {
      config: {
        rateLimit: publicRateLimits.passwordReset,
      },
      schema: {
        body: CommitteeInviteSetPasswordSchema,
      },
    },
    async (request, reply) => {
      const result = await setCommitteeMemberPasswordWithInvite(
        request.body.token,
        request.body.password,
      );
      return reply.send(result);
    },
  );

  // POST /api/public/committee/invite/resend
  app.post<{
    Body: CommitteeInviteResendInput;
  }>(
    "/committee/invite/resend",
    {
      config: {
        rateLimit: publicRateLimits.committeeInviteResend,
      },
      schema: {
        body: CommitteeInviteResendSchema,
      },
    },
    async (request, reply) => {
      // Always { ok: true } — never disclose whether the token maps to a real,
      // still-eligible committee member.
      const result = await resendCommitteeInviteWithToken(request.body.token);
      return reply.send(result);
    },
  );
}
