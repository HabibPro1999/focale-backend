import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ThrottlerException, ThrottlerStorageService } from "@nestjs/throttler";
import { NetworkingThrottlerGuard, networkingIpThrottler } from "../../core/networking-throttler.guard";
import { NetworkingPublicController } from "./networking.public.controller";
import { NetworkingMfaController } from "./networking.mfa.controller";
import { HttpExceptionFilter } from "../../core/http-exception.filter";

class OtherController { list() {} }

describe("networking identity throttling", () => {
  let storage: ThrottlerStorageService;
  let guard: NetworkingThrottlerGuard;
  beforeEach(async () => {
    vi.useFakeTimers();
    storage = new ThrottlerStorageService();
    guard = new NetworkingThrottlerGuard([networkingIpThrottler, { ttl: 60_000, limit: 100 }], storage, new Reflector());
    await guard.onModuleInit();
  });
  afterEach(() => { storage.onApplicationShutdown(); vi.useRealTimers(); });
  function context(handler: Function, body = {}, token?: string, controller: Function = NetworkingPublicController, url = "/api/networking/event/auth/request") {
    const req = { url, params: { slug: "event" }, ip: "192.0.2.1", body, headers: token ? { authorization: `Bearer ${token}` } : {} };
    const reply = { header: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), send: vi.fn() };
    return { getHandler: () => handler, getClass: () => controller, switchToHttp: () => ({ getRequest: () => req, getResponse: () => reply }) } as unknown as ExecutionContext;
  }
  const otp = NetworkingPublicController.prototype.requestCode;
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
    const verify = (id: string) => context(NetworkingPublicController.prototype.verifyCode, { challengeId: id }, undefined, NetworkingPublicController, "/api/networking/event/auth/verify");
    const first = verify("00000000-0000-4000-8000-000000000001");
    const second = verify("00000000-0000-4000-8000-000000000002");
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
    const mutation = (token: string) => context(NetworkingPublicController.prototype.updateMe, {}, token, NetworkingPublicController, "/api/networking/event/me");
    for (let i = 0; i < 100; i++) await guard.canActivate(mutation("one"));
    await expect(guard.canActivate(mutation("one"))).rejects.toBeInstanceOf(ThrottlerException);
    expect(await guard.canActivate(mutation("two"))).toBe(true);
  });
  it("enforces a shared 600/min IP ceiling across networking handlers", async () => {
    for (let i = 0; i < 600; i++) await guard.canActivate(context(otp, { email: `person${i}@example.com` }));
    await expect(guard.canActivate(context(NetworkingPublicController.prototype.config, {}, undefined, NetworkingPublicController, "/api/networking/event/config"))).rejects.toBeInstanceOf(ThrottlerException);
  });
  it("allows 600 anonymous config reads, not the legacy 100", async () => {
    const ctx = context(NetworkingPublicController.prototype.config, {}, undefined, NetworkingPublicController, "/api/networking/event/config");
    for (let i = 0; i < 600; i++) await guard.canActivate(ctx);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ThrottlerException);
  });
  it("keeps legacy per-IP limits outside networking regardless of bearer", async () => {
    for (let i = 0; i < 100; i++) await guard.canActivate(context(OtherController.prototype.list, {}, `session${i}`, OtherController, "/api/events?next=/networking"));
    await expect(guard.canActivate(context(OtherController.prototype.list, {}, "new", OtherController, "/api/events"))).rejects.toBeInstanceOf(ThrottlerException);
  });
});
