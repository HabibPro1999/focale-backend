import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ThrottlerException, ThrottlerStorageService, type ThrottlerOptions } from "@nestjs/throttler";
import {
  NETWORKING_ORGANIZER_LIMIT,
  NETWORKING_UNVERIFIED_LIMIT,
  NetworkingThrottlerGuard,
  isParticipantNetworkingRequest,
  networkingThrottlers,
  networkingUnverifiedThrottler,
} from "../../core/networking-throttler.guard";
import {
  NETWORKING_BEARER_LOCKOUT,
  networkingBearerLockout,
  networkingIdentityCache,
  networkingVenueKey,
} from "../../core/networking-identity-cache";
import { NetworkingPublicController } from "./networking.public.controller";
import { NetworkingMfaController } from "./networking.mfa.controller";
import { NetworkingAdminController } from "./networking.admin.controller";
import { HttpExceptionFilter } from "../../core/http-exception.filter";

class OtherController { list() {} }

const IP = "192.0.2.1";
const verify = (token: string, sessionId = `session-for-${token}`) =>
  networkingIdentityCache.remember(token, { id: sessionId, profileId: `profile-for-${token}`, expiresAt: new Date("2099-01-01T00:00:00Z") });

describe("networking identity throttling", () => {
  let storage: ThrottlerStorageService;
  let guard: NetworkingThrottlerGuard;
  async function makeGuard(throttlers: ThrottlerOptions[] = networkingThrottlers) {
    const instance = new NetworkingThrottlerGuard([...throttlers, { ttl: 60_000, limit: 100 }], storage, new Reflector());
    await instance.onModuleInit();
    return instance;
  }
  beforeEach(async () => {
    vi.useFakeTimers();
    networkingIdentityCache.clear();
    networkingBearerLockout.clear();
    storage = new ThrottlerStorageService();
    guard = await makeGuard();
  });
  afterEach(() => { storage.onApplicationShutdown(); vi.useRealTimers(); });
  function context(handler: Function, body = {}, token?: string, controller: Function = NetworkingPublicController, url = "/api/networking/event/auth/request", options: { ip?: string; slug?: string; route?: string } = {}) {
    const req = {
      url, ip: options.ip ?? IP, body,
      params: { slug: options.slug ?? "event" },
      ...(options.route ? { routeOptions: { url: options.route } } : {}),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    };
    const reply = { header: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), send: vi.fn() };
    return { getHandler: () => handler, getClass: () => controller, switchToHttp: () => ({ getRequest: () => req, getResponse: () => reply }) } as unknown as ExecutionContext;
  }
  const otp = NetworkingPublicController.prototype.requestCode;
  const verifyCode = NetworkingPublicController.prototype.verifyCode;
  const mutation = (token: string, slug = "event", ip = IP) => context(NetworkingPublicController.prototype.updateMe, {}, token, NetworkingPublicController, `/api/networking/${slug}/me`, { slug, ip, route: "/api/networking/:slug/me" });
  const read = (token: string, slug = "event") => context(NetworkingPublicController.prototype.connections, {}, token, NetworkingPublicController, `/api/networking/${slug}/connections`, { slug, route: "/api/networking/:slug/connections" });
  const config = (token?: string) => context(NetworkingPublicController.prototype.config, {}, token, NetworkingPublicController, "/api/networking/event/config", { route: "/api/networking/:slug/config" });
  const mfaVerify = (token: string) => context(NetworkingMfaController.prototype.verify, {}, token, NetworkingMfaController, "/api/networking/event/auth/mfa/verify");
  const scan = (token: string, ip = IP) => context(NetworkingAdminController.prototype.verifyBadge, {}, token, NetworkingAdminController, "/api/events/e1/networking/badges/verify", { ip, route: "/api/events/:eventId/networking/badges/verify" });
  const reject = async (ctx: ExecutionContext) => {
    const error = await guard.canActivate(ctx).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ThrottlerException);
    return error as ThrottlerException;
  };
  const lockOut = (venue = networkingVenueKey(IP, "event")) => {
    for (let i = 0; i < NETWORKING_BEARER_LOCKOUT.threshold; i++) networkingBearerLockout.recordRejected(venue, `rejected-${i}`);
  };

  it("accepts nine distinct emails behind one venue IP", async () => {
    for (let i = 0; i < 9; i++) expect(await guard.canActivate(context(otp, { email: `person${i}@example.com` }))).toBe(true);
  });
  it("normalizes email and rejects the sixth request within ten minutes with the networking code", async () => {
    for (let i = 0; i < 5; i++) await guard.canActivate(context(otp, { email: " Person@Example.com " }));
    await vi.advanceTimersByTimeAsync(60_001);
    const ctx = context(otp, { email: "person@example.com" }, "cannot-bypass-with-bearer");
    const exception = await reject(ctx);
    new HttpExceptionFilter().catch(exception, ctx);
    expect(ctx.switchToHttp().getResponse().status).toHaveBeenCalledWith(429);
    expect(ctx.switchToHttp().getResponse().send).toHaveBeenCalledWith(expect.objectContaining({ error: { code: "NETWORKING_RATE_LIMITED", message: "Too many requests" } }));
  });
  it("isolates verification challenges and rejects attempt eleven", async () => {
    const attempt = (id: string) => context(verifyCode, { challengeId: id }, undefined, NetworkingPublicController, "/api/networking/event/auth/verify");
    const first = attempt("00000000-0000-4000-8000-000000000001");
    const second = attempt("00000000-0000-4000-8000-000000000002");
    for (let i = 0; i < 10; i++) { await guard.canActivate(first); await guard.canActivate(second); }
    await reject(first);
  });

  describe("verified sessions", () => {
    it("gives each verified session its own 30-message chat quota", async () => {
      const chat = (token: string) => context(NetworkingPublicController.prototype.message, {}, token, NetworkingPublicController, "/api/networking/event/connections/one/messages");
      for (const token of ["one", "two", "three"]) verify(token);
      for (let i = 0; i < 30; i++) { await guard.canActivate(chat("one")); await guard.canActivate(chat("two")); }
      await reject(chat("one"));
      expect(await guard.canActivate(chat("three"))).toBe(true);
    });
    it("gives MFA sessions independent ten-attempt quotas", async () => {
      verify("one"); verify("two");
      for (let i = 0; i < 10; i++) await guard.canActivate(mfaVerify("one"));
      await reject(mfaVerify("one"));
      expect(await guard.canActivate(mfaVerify("two"))).toBe(true);
    });
    it("isolates ordinary mutations by session", async () => {
      verify("one"); verify("two");
      for (let i = 0; i < 100; i++) await guard.canActivate(mutation("one"));
      await reject(mutation("one"));
      expect(await guard.canActivate(mutation("two"))).toBe(true);
    });
    it("never lets a bearer that merely names a session id draw on that session's quota", async () => {
      verify("real-token", "session-1");
      for (let i = 0; i < 100; i++) await guard.canActivate(mutation("real-token"));
      await reject(mutation("real-token"));
      expect(await guard.canActivate(mutation("session-1"))).toBe(true);
    });
    it("stays unaffected by the unverified bucket and the lockout", async () => {
      verify("known");
      const tight = await makeGuard([...networkingThrottlers.filter((t) => t !== networkingUnverifiedThrottler), { ...networkingUnverifiedThrottler, limit: 3 }]);
      for (let i = 0; i < 3; i++) await tight.canActivate(read(`unknown-${i}`));
      await expect(tight.canActivate(read("unknown-x"))).rejects.toBeInstanceOf(ThrottlerException);
      lockOut();
      expect(await tight.canActivate(read("known"))).toBe(true);
    });
  });

  describe("unverified bearers", () => {
    it("share one bucket per venue IP and event across tokens and handlers, independently per slug and IP", async () => {
      const tight = await makeGuard([...networkingThrottlers.filter((t) => t !== networkingUnverifiedThrottler), { ...networkingUnverifiedThrottler, limit: 30 }]);
      for (let i = 0; i < 15; i++) { await tight.canActivate(mutation(`random-${i}`)); await tight.canActivate(read(`random-read-${i}`)); }
      await expect(tight.canActivate(mutation("rotated"))).rejects.toBeInstanceOf(ThrottlerException);
      expect(await tight.canActivate(mutation("rotated", "other-event"))).toBe(true);
      expect(await tight.canActivate(mutation("rotated", "event", "198.51.100.7"))).toBe(true);
      // Requests without a bearer keep the per-IP default instead.
      expect(await tight.canActivate(context(NetworkingPublicController.prototype.me, {}, undefined, NetworkingPublicController, "/api/networking/event/me"))).toBe(true);
    });
    it("keep a per-token quota for a repeated unknown token", async () => {
      for (let i = 0; i < 100; i++) await guard.canActivate(mutation("same-unknown"));
      await reject(mutation("same-unknown"));
      expect(await guard.canActivate(mutation("other-unknown"))).toBe(true);
    });
    it("absorb a cold cache at venue scale: 2,000 attendees x 5 requests without a 429", { timeout: 120_000 }, async () => {
      expect(NETWORKING_UNVERIFIED_LIMIT).toBe(12_000);
      for (let attendee = 0; attendee < 2_000; attendee++)
        for (let i = 0; i < 5; i++) expect(await guard.canActivate(read(`attendee-${attendee}`))).toBe(true);
    });
    it("move to the session bucket once the service verifies the token", async () => {
      const tight = await makeGuard([...networkingThrottlers.filter((t) => t !== networkingUnverifiedThrottler), { ...networkingUnverifiedThrottler, limit: 1 }]);
      await tight.canActivate(read("fresh"));
      await expect(tight.canActivate(read("fresh"))).rejects.toBeInstanceOf(ThrottlerException);
      verify("fresh");
      expect(await tight.canActivate(read("fresh"))).toBe(true);
    });
  });

  describe("invalid-bearer lockout", () => {
    it("rejects unverified bearers for ten minutes with the networking 429 and a Retry-After", async () => {
      lockOut();
      const ctx = mutation("unknown");
      const exception = await reject(ctx);
      const reply = ctx.switchToHttp().getResponse();
      expect(reply.header).toHaveBeenCalledWith("Retry-After", 600);
      new HttpExceptionFilter().catch(exception, ctx);
      expect(reply.status).toHaveBeenCalledWith(429);
      expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ error: { code: "NETWORKING_RATE_LIMITED", message: "Too many requests" } }));
      await vi.advanceTimersByTimeAsync(NETWORKING_BEARER_LOCKOUT.durationMs);
      expect(await guard.canActivate(mutation("unknown"))).toBe(true);
    });
    it("spares verified sessions, sign-in routes, bearer-agnostic reads and other venues", async () => {
      lockOut();
      verify("known");
      expect(await guard.canActivate(mutation("known"))).toBe(true);
      expect(await guard.canActivate(context(otp, { email: "person@example.com" }, "unknown"))).toBe(true);
      expect(await guard.canActivate(context(verifyCode, { challengeId: "00000000-0000-4000-8000-000000000001" }, "unknown", NetworkingPublicController, "/api/networking/event/auth/verify"))).toBe(true);
      expect(await guard.canActivate(mfaVerify("unknown"))).toBe(true);
      expect(await guard.canActivate(config("unknown"))).toBe(true);
      expect(await guard.canActivate(mutation("unknown", "other-event"))).toBe(true);
      expect(await guard.canActivate(mutation("unknown", "event", "198.51.100.7"))).toBe(true);
      expect(await guard.canActivate(scan("organizer-token"))).toBe(true);
    });
  });

  it("caps sign-in at 300/min per venue IP and event across distinct emails, independently per slug and IP", async () => {
    for (let i = 0; i < 300; i++) await guard.canActivate(context(otp, { email: `person${i}@example.com` }));
    await reject(context(otp, { email: "late@example.com" }));
    expect(await guard.canActivate(context(otp, { email: "late@example.com" }, undefined, NetworkingPublicController, "/api/networking/other/auth/request", { slug: "other" }))).toBe(true);
    expect(await guard.canActivate(context(otp, { email: "late@example.com" }, undefined, NetworkingPublicController, "/api/networking/event/auth/request", { ip: "198.51.100.7" }))).toBe(true);
    // Only the sign-in endpoints share this bucket.
    expect(await guard.canActivate(mutation("session"))).toBe(true);
  });
  it("shares a 24,000/min venue bucket per IP and event across every participant handler", { timeout: 120_000 }, async () => {
    for (let session = 0; session < 240; session++) verify(`session-${session}`);
    for (let session = 0; session < 240; session++)
      for (let i = 0; i < 100; i++) await guard.canActivate(mutation(`session-${session}`));
    verify("fresh");
    await reject(mutation("fresh"));
    expect(await guard.canActivate(mutation("fresh", "other-event"))).toBe(true);
  });
  it("lets config and registration reads skip the per-IP default and use only the venue bucket, bearer or not", async () => {
    for (const [handler, path] of [[NetworkingPublicController.prototype.config, "config"], [NetworkingPublicController.prototype.registration, "registration"]] as const) {
      for (const token of [undefined, "unverified"]) {
        const ctx = context(handler, {}, token, NetworkingPublicController, `/api/networking/event/${path}`, { route: `/api/networking/:slug/${path}` });
        for (let i = 0; i < 1_000; i++) expect(await guard.canActivate(ctx)).toBe(true);
      }
    }
  });
  it("keeps organizer badge scanning per bearer token and out of the venue bucket", async () => {
    for (let i = 0; i < 100; i++) { await guard.canActivate(scan("staff-a")); await guard.canActivate(scan("staff-b")); }
    await reject(scan("staff-a"));
    expect(await guard.canActivate(scan("staff-c"))).toBe(true);
  });
  it("backstops organizer networking routes at 600/min per IP across rotating bearers", async () => {
    expect(NETWORKING_ORGANIZER_LIMIT).toBe(600);
    for (let i = 0; i < 600; i++) expect(await guard.canActivate(scan(`rotating-${i}`))).toBe(true);
    const ctx = scan("rotating-next");
    const exception = await reject(ctx);
    new HttpExceptionFilter().catch(exception, ctx);
    expect(ctx.switchToHttp().getResponse().send).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: "RATE_4001" }) }));
    const config = context(NetworkingAdminController.prototype.verifyBadge, {}, "rotating-next", NetworkingAdminController, "/api/events/e2/networking/config", { route: "/api/events/:eventId/networking/config" });
    await reject(config);
    expect(await guard.canActivate(scan("rotating-next", "198.51.100.7"))).toBe(true);
    expect(await guard.canActivate(mutation("participant"))).toBe(true);
  });
  it("keeps legacy per-IP limits outside networking regardless of bearer", async () => {
    for (let i = 0; i < 100; i++) await guard.canActivate(context(OtherController.prototype.list, {}, `session${i}`, OtherController, "/api/events?next=/networking"));
    await reject(context(OtherController.prototype.list, {}, "new", OtherController, "/api/events"));
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
