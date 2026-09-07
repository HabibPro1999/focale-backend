import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildApp } from "../../app.factory";
import { CommitteeInviteService } from "./abstracts.committee-invite.service";
import { AppException } from "../../core/app-exception";
import { ErrorCodes } from "@app/contracts";

describe("public committee invite HTTP contract", () => {
  let app: NestFastifyApplication;
  let service: CommitteeInviteService;
  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    service = app.get(CommitteeInviteService);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
  });
  const token = "a".repeat(64);
  it("ignores stray auth headers and envelopes verification at 200", async () => {
    vi.spyOn(service, "verifyCommitteeInvite").mockResolvedValue({
      email: "reviewer@example.com",
      name: "Reviewer",
      eventName: "Event",
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/public/committee/invite/verify",
      headers: { authorization: "Bearer invalid-token" },
      payload: { token },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      data: { email: "reviewer@example.com" },
    });
  });
  it("rejects malformed tokens before calling the service", async () => {
    const spy = vi.spyOn(service, "verifyCommitteeInvite");
    spy.mockClear();
    const response = await app.inject({
      method: "POST",
      url: "/api/public/committee/invite/verify",
      payload: { token: "bad" },
    });
    expect(response.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });
  it("uses distinct 410 errors for dead links without signing out the caller", async () => {
    vi.spyOn(service, "verifyCommitteeInvite").mockRejectedValue(
      new AppException(ErrorCodes.COMMITTEE_INVITE_EXPIRED, "Expired", 410),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/public/committee/invite/verify",
      payload: { token },
    });
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: ErrorCodes.COMMITTEE_INVITE_EXPIRED },
    });
  });
  it("validates strong passwords and then forwards a valid password", async () => {
    const spy = vi
      .spyOn(service, "setCommitteeMemberPasswordWithInvite")
      .mockResolvedValue({ ok: true, email: "r@example.com" });
    const bad = await app.inject({
      method: "POST",
      url: "/api/public/committee/invite/set-password",
      payload: { token, password: "weak" },
    });
    expect(bad.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    const good = await app.inject({
      method: "POST",
      url: "/api/public/committee/invite/set-password",
      payload: { token, password: "StrongPassword1!" },
    });
    expect(good.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(token, "StrongPassword1!");
  });
  it("rate-limits self-service resend to three requests per minute", async () => {
    vi.spyOn(service, "resendCommitteeInviteWithToken").mockResolvedValue({
      ok: true,
    });
    for (let i = 0; i < 3; i++) {
      const response = await app.inject({
        method: "POST",
        url: "/api/public/committee/invite/resend",
        payload: { token },
      });
      expect(response.statusCode).toBe(200);
    }
    const response = await app.inject({
      method: "POST",
      url: "/api/public/committee/invite/resend",
      payload: { token },
    });
    expect(response.statusCode).toBe(429);
  });
});
