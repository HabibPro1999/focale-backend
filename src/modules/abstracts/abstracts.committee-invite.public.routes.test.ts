import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import rateLimit from "@fastify/rate-limit";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { errorHandler } from "@shared/middleware/error.middleware.js";
import { committeeInvitePublicRoutes } from "./abstracts.committee-invite.public.routes.js";

vi.mock("./abstracts.committee-invite.service.js", () => ({
  verifyCommitteeInvite: vi.fn(),
  setCommitteeMemberPasswordWithInvite: vi.fn(),
  resendCommitteeInviteWithToken: vi.fn(),
}));

import {
  verifyCommitteeInvite,
  setCommitteeMemberPasswordWithInvite,
  resendCommitteeInviteWithToken,
} from "./abstracts.committee-invite.service.js";

const TOKEN = "a1b2c3d4".repeat(8); // 64 hex chars
const PASSWORD = "Str0ng!Passw0rd";

async function buildTestApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // The real error handler is wired in so 410 propagation can be asserted.
  app.setErrorHandler(errorHandler);
  await app.register(sensible, { sharedSchemaId: "HttpError" });
  await app.register(rateLimit, { max: 1000, timeWindow: "1 minute" });
  await app.register(committeeInvitePublicRoutes, { prefix: "/api/public" });
  return app;
}

describe("committee invite public routes", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  describe("POST /api/public/committee/invite/verify", () => {
    it("returns 200 with the invitee details", async () => {
      (verifyCommitteeInvite as ReturnType<typeof vi.fn>).mockResolvedValue({
        email: "committee@example.com",
        name: "Committee Member",
        eventName: "Big Event",
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/public/committee/invite/verify",
        payload: { token: TOKEN },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        email: "committee@example.com",
        name: "Committee Member",
        eventName: "Big Event",
      });
      expect(verifyCommitteeInvite).toHaveBeenCalledWith(TOKEN);
    });

    it("is not reachable over GET, so the token never lands in a query string", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/public/committee/invite?token=${TOKEN}`,
      });

      expect(response.statusCode).toBe(404);
      expect(verifyCommitteeInvite).not.toHaveBeenCalled();
    });

    it.each([
      ["missing", undefined],
      ["too short", "abc"],
      ["non-hex", "z".repeat(64)],
      ["too long", "a".repeat(65)],
    ])("returns 400 (never 401) for a %s token", async (_label, token) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/public/committee/invite/verify",
        payload: token === undefined ? {} : { token },
      });

      expect(response.statusCode).toBe(400);
      expect(verifyCommitteeInvite).not.toHaveBeenCalled();
    });

    it("propagates a 410 AppError with its committee-invite code", async () => {
      (verifyCommitteeInvite as ReturnType<typeof vi.fn>).mockRejectedValue(
        new AppError(
          "This invitation link has expired",
          410,
          ErrorCodes.COMMITTEE_INVITE_EXPIRED,
        ),
      );

      const response = await app.inject({
        method: "POST",
        url: "/api/public/committee/invite/verify",
        payload: { token: TOKEN },
      });

      expect(response.statusCode).toBe(410);
      const body = JSON.parse(response.body);
      expect(body.code).toBe(ErrorCodes.COMMITTEE_INVITE_EXPIRED);
      expect(body.error).toBe("This invitation link has expired");
    });
  });

  describe("POST /api/public/committee/invite/set-password", () => {
    it("returns 200 with { ok, email }", async () => {
      (
        setCommitteeMemberPasswordWithInvite as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ ok: true, email: "committee@example.com" });

      const response = await app.inject({
        method: "POST",
        url: "/api/public/committee/invite/set-password",
        payload: { token: TOKEN, password: PASSWORD },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        ok: true,
        email: "committee@example.com",
      });
      expect(setCommitteeMemberPasswordWithInvite).toHaveBeenCalledWith(
        TOKEN,
        PASSWORD,
      );
    });

    it("returns 400 for a weak password", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/public/committee/invite/set-password",
        payload: { token: TOKEN, password: "short" },
      });

      expect(response.statusCode).toBe(400);
      expect(setCommitteeMemberPasswordWithInvite).not.toHaveBeenCalled();
    });

    it("returns 400 for a malformed token", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/public/committee/invite/set-password",
        payload: { token: "nope", password: PASSWORD },
      });

      expect(response.statusCode).toBe(400);
      expect(setCommitteeMemberPasswordWithInvite).not.toHaveBeenCalled();
    });

    it("returns 410 INV_19003 when the token was already used", async () => {
      (
        setCommitteeMemberPasswordWithInvite as ReturnType<typeof vi.fn>
      ).mockRejectedValue(
        new AppError(
          "This invitation link has already been used",
          410,
          ErrorCodes.COMMITTEE_INVITE_USED,
        ),
      );

      const response = await app.inject({
        method: "POST",
        url: "/api/public/committee/invite/set-password",
        payload: { token: TOKEN, password: PASSWORD },
      });

      expect(response.statusCode).toBe(410);
      expect(JSON.parse(response.body).code).toBe(
        ErrorCodes.COMMITTEE_INVITE_USED,
      );
    });
  });

  describe("POST /api/public/committee/invite/resend", () => {
    it("returns 200 { ok: true }", async () => {
      (
        resendCommitteeInviteWithToken as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ ok: true });

      const response = await app.inject({
        method: "POST",
        url: "/api/public/committee/invite/resend",
        payload: { token: TOKEN },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ ok: true });
      expect(resendCommitteeInviteWithToken).toHaveBeenCalledWith(TOKEN);
    });

    it("returns 200 { ok: true } even for an unknown token (anti-enumeration)", async () => {
      (
        resendCommitteeInviteWithToken as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ ok: true });

      const response = await app.inject({
        method: "POST",
        url: "/api/public/committee/invite/resend",
        payload: { token: "f".repeat(64) },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ ok: true });
    });

    it("returns 400 for a malformed token", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/public/committee/invite/resend",
        payload: { token: "nope" },
      });

      expect(response.statusCode).toBe(400);
      expect(resendCommitteeInviteWithToken).not.toHaveBeenCalled();
    });
  });

  it("never answers 401, even with a stray Authorization header", async () => {
    (verifyCommitteeInvite as ReturnType<typeof vi.fn>).mockResolvedValue({
      email: "committee@example.com",
      name: "Committee Member",
      eventName: "Big Event",
    });
    (
      resendCommitteeInviteWithToken as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ ok: true });

    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/public/committee/invite/verify",
        payload: { token: TOKEN },
        headers: { authorization: "Bearer garbage" },
      }),
      app.inject({
        method: "POST",
        url: "/api/public/committee/invite/verify",
        payload: { token: "bad" },
        headers: { authorization: "Bearer garbage" },
      }),
      app.inject({
        method: "POST",
        url: "/api/public/committee/invite/resend",
        payload: { token: TOKEN },
        headers: { authorization: "Bearer garbage" },
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).not.toBe(401);
    }
  });
});
