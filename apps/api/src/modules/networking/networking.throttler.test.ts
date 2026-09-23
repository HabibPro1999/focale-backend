import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ThrottlerException, ThrottlerStorageService } from "@nestjs/throttler";
import { NetworkingThrottlerGuard, isParticipantNetworkingRequest, networkingAuthThrottler, networkingVenueThrottler } from "../../core/networking-throttler.guard";
import { NetworkingPublicController } from "./networking.public.controller";
import { NetworkingMfaController } from "./networking.mfa.controller";
import { NetworkingAdminController } from "./networking.admin.controller";
import { HttpExceptionFilter } from "../../core/http-exception.filter";

class OtherController { list() {} }

describe("networking identity throttling", () => {
  let storage: ThrottlerStorageService;
  let guard: NetworkingThrottlerGuard;
  beforeEach(async () => {
    vi.useFakeTimers();
    storage = new ThrottlerStorageService();
    guard = new NetworkingThrottlerGuard([networkingVenueThrottler, networkingAuthThrottler, { ttl: 60_000, limit: 100 }], storage, new Reflector());
    await guard.onModuleInit();
  });
  afterEach(() => { storage.onApplicationShutdown(); vi.useRealTimers(); });
  function context(handler: Function, body = {}, token?: string, controller: Function = NetworkingPublicController, url = "/api/networking/event/auth/request", options: { ip?: string; slug?: string; route?: string } = {}) {
    const req = {
      url, ip: options.ip ?? "192.0.2.1", body,
      params: { slug: options.slug ?? "event" },
      ...(options.route ? { routeOptions: { url: options.route } } : {}),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    };
    const reply = { header: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), send: vi.fn() };
    return { getHandler: () => handler, getClass: () => controller, switchToHttp: () => ({ getRequest: () => req, getResponse: () => reply }) } as unknown as ExecutionContext;
  }
  const otp = NetworkingPublicController.prototype.requestCode;
  const verify = NetworkingPublicController.prototype.verifyCode;
  const mutation = (token: string, slug = "event") => context(NetworkingPublicController.prototype.updateMe, {}, token, NetworkingPublicController, `/api/networking/${slug}/me`, { slug, route: "/api/networking/:slug/me" });
  it("accepts nine distinct emails behind one venue IP", async () => {
    for (let i = 0; i < 9; i++) expect(await guard.canActivate(context(otp, { email: `person${i}@example.com` }))).toBe(true);
  });
  it("normalizes email and rejects the sixth request within ten minutes with the networking code", async () => {
    for (let i = 0; i < 5; i++) await guard.canActivate(context(otp, { email: " Person@Example.com " }));
    await vi.advanceTimersByTimeAsync(60_001);
    const ctx = context(otp, { email: "person@example.com" }, "cannot-bypass-with-bearer");
    const exception = await guard.canActivate(ctx).catch(e => e);
    expect(exception).toBeInstanceOf(ThrottlerException);
    new HttpExceptionFilter().catch(exception, ctx);
    expect(ctx.switchToHttp().getResponse().status).toHaveBeenCalledWith(429);
    expect(ctx.switchToHttp().getResponse().send).toHaveBeenCalledWith(expect.objectContaining({ error: { code: "NETWORKING_RATE_LIMITED", message: "Too many requests" } }));
  });
  it("isolates verification challenges and rejects attempt eleven", async () => {
    const attempt = (id: string) => context(verify, { challengeId: id }, undefined, NetworkingPublicController, "/api/networking/event/auth/verify");
    const first = attempt("00000000-0000-4000-8000-000000000001");
    const second = attempt("00000000-0000-4000-8000-000000000002");
    for (let i = 0; i < 10; i++) { await guard.canActivate(first); await guard.canActivate(second); }
    await expect(guard.canActivate(first)).rejects.toBeInstanceOf(ThrottlerException);
  });
  it("gives each bearer session its own 30-message chat quota", async () => {
    const chat = (token: string) => context(NetworkingPublicController.prototype.message, {}, token, NetworkingPublicController, "/api/networking/event/connections/one/messages");
    for (let i = 0; i < 30; i++) { await guard.canActivate(chat("one")); await guard.canActivate(chat("two")); }
    await expect(guard.canActivate(chat("one"))).rejects.toBeInstanceOf(ThrottlerException);
    expect(await guard.canActivate(chat("three"))).toBe(true);
  });
  it("gives MFA sessions independent ten-attempt quotas", async () => {
    const mfa = (token: string) => context(NetworkingMfaController.prototype.verify, {}, token, NetworkingMfaController, "/api/networking/event/auth/mfa/verify");
    for (let i = 0; i < 10; i++) await guard.canActivate(mfa("one"));
    await expect(guard.canActivate(mfa("one"))).rejects.toBeInstanceOf(ThrottlerException);
    expect(await guard.canActivate(mfa("two"))).toBe(true);
  });
  it("isolates ordinary mutations by session", async () => {
    for (let i = 0; i < 100; i++) await guard.canActivate(mutation("one"));
    await expect(guard.canActivate(mutation("one"))).rejects.toBeInstanceOf(ThrottlerException);
    expect(await guard.canActivate(mutation("two"))).toBe(true);
  });
  it("caps sign-in at 300/min per venue IP and event across distinct emails, independently per slug and IP", async () => {
    for (let i = 0; i < 300; i++) await guard.canActivate(context(otp, { email: `person${i}@example.com` }));
    await expect(guard.canActivate(context(otp, { email: "late@example.com" }))).rejects.toBeInstanceOf(ThrottlerException);
    expect(await guard.canActivate(context(otp, { email: "late@example.com" }, undefined, NetworkingPublicController, "/api/networking/other/auth/request", { slug: "other" }))).toBe(true);
    expect(await guard.canActivate(context(otp, { email: "late@example.com" }, undefined, NetworkingPublicController, "/api/networking/event/auth/request", { ip: "198.51.100.7" }))).toBe(true);
    // Only the sign-in endpoints share this bucket.
    expect(await guard.canActivate(mutation("session"))).toBe(true);
  });
  it("shares a 24,000/min venue bucket per IP and event across every participant handler", async () => {
    for (let session = 0; session < 240; session++)
      for (let i = 0; i < 100; i++) await guard.canActivate(mutation(`session-${session}`));
    await expect(guard.canActivate(mutation("fresh"))).rejects.toBeInstanceOf(ThrottlerException);
    expect(await guard.canActivate(mutation("fresh", "other-event"))).toBe(true);
  });
  it("lets config and registration reads skip the per-IP default and use only the venue bucket", async () => {
    for (const [handler, path] of [[NetworkingPublicController.prototype.config, "config"], [NetworkingPublicController.prototype.registration, "registration"]] as const) {
      const ctx = context(handler, {}, undefined, NetworkingPublicController, `/api/networking/event/${path}`, { route: `/api/networking/:slug/${path}` });
      for (let i = 0; i < 1_000; i++) expect(await guard.canActivate(ctx)).toBe(true);
    }
  });
  it("keeps organizer badge scanning per bearer token and out of the venue bucket", async () => {
    const scan = (token: string) => context(NetworkingAdminController.prototype.verifyBadge, {}, token, NetworkingAdminController, "/api/events/e1/networking/badges/verify", { route: "/api/events/:eventId/networking/badges/verify" });
    for (let i = 0; i < 100; i++) { await guard.canActivate(scan("staff-a")); await guard.canActivate(scan("staff-b")); }
    await expect(guard.canActivate(scan("staff-a"))).rejects.toBeInstanceOf(ThrottlerException);
    expect(await guard.canActivate(scan("staff-c"))).toBe(true);
  });
  it("keeps legacy per-IP limits outside networking regardless of bearer", async () => {
    for (let i = 0; i < 100; i++) await guard.canActivate(context(OtherController.prototype.list, {}, `session${i}`, OtherController, "/api/events?next=/networking"));
    await expect(guard.canActivate(context(OtherController.prototype.list, {}, "new", OtherController, "/api/events"))).rejects.toBeInstanceOf(ThrottlerException);
  });
});

describe("participant networking route detection", () => {
  it.each([
    [{ routeOptions: { url: "/api/networking/:slug/me" }, url: "/api/networking/demo/me?x=1" }, true],
    [{ url: "/api/networking/demo/auth/request?next=1" }, true],
    [{ routeOptions: { url: "/api/events/:eventId/networking/config" }, url: "/api/events/e/networking/config" }, false],
    [{ url: "/api/events?next=/api/networking/demo" }, false],
    [{ url: "/api/events/e/networking" }, false],
    [undefined, false],
  ])("%j ⇒ %s", (req, expected) => {
    expect(isParticipantNetworkingRequest(req)).toBe(expected);
  });
});
