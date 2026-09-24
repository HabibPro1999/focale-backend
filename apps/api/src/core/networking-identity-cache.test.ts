import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NETWORKING_BEARER_LOCKOUT,
  NetworkingBearerLockout,
  NetworkingIdentityCache,
  networkingBearerToken,
} from "./networking-identity-cache";

const farFuture = new Date("2099-01-01T00:00:00Z");
const session = (id: string, profileId = `profile-${id}`, expiresAt = farFuture) => ({ id, profileId, expiresAt });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2031-04-05T09:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("NetworkingIdentityCache", () => {
  it("maps only remembered tokens to their session", () => {
    const cache = new NetworkingIdentityCache();
    cache.remember("token-a", session("s1"));
    expect(cache.sessionFor("token-a")).toBe("s1");
    expect(cache.sessionFor("token-b")).toBeUndefined();
  });

  it("expires entries after five minutes, or at the session's expiry when sooner", () => {
    const cache = new NetworkingIdentityCache();
    cache.remember("long", session("s1"));
    cache.remember("short", session("s2", "p2", new Date(Date.now() + 60_000)));
    vi.advanceTimersByTime(60_000);
    expect(cache.sessionFor("short")).toBeUndefined();
    expect(cache.sessionFor("long")).toBe("s1");
    vi.advanceTimersByTime(4 * 60_000 - 1);
    expect(cache.sessionFor("long")).toBe("s1");
    vi.advanceTimersByTime(1);
    expect(cache.sessionFor("long")).toBeUndefined();
  });

  it("restarts the five minutes each time the service re-verifies the session", () => {
    const cache = new NetworkingIdentityCache();
    cache.remember("token", session("s1"));
    vi.advanceTimersByTime(4 * 60_000);
    cache.remember("token", session("s1"));
    vi.advanceTimersByTime(4 * 60_000);
    expect(cache.sessionFor("token")).toBe("s1");
  });

  it("never remembers an already expired session", () => {
    const cache = new NetworkingIdentityCache();
    cache.remember("token", session("s1"));
    cache.remember("token", session("s1", "p1", new Date(Date.now() - 1)));
    expect(cache.sessionFor("token")).toBeUndefined();
  });

  it("evicts the least recently used entry at capacity", () => {
    const cache = new NetworkingIdentityCache(3);
    cache.remember("a", session("sa"));
    cache.remember("b", session("sb"));
    cache.remember("c", session("sc"));
    expect(cache.sessionFor("a")).toBe("sa");
    cache.remember("d", session("sd"));
    expect(cache.size).toBe(3);
    expect(cache.sessionFor("b")).toBeUndefined();
    expect(cache.sessionFor("a")).toBe("sa");
  });

  it("forgets by token, by session and by participant", () => {
    const cache = new NetworkingIdentityCache();
    cache.remember("a", session("sa", "p1"));
    cache.remember("b", session("sb", "p1"));
    cache.remember("c", session("sc", "p2"));
    cache.remember("d", session("sd", "p3"));
    cache.forgetToken("a");
    expect(cache.sessionFor("a")).toBeUndefined();
    cache.forgetProfile("p1");
    expect(cache.sessionFor("b")).toBeUndefined();
    cache.forgetSession("sc");
    expect(cache.sessionFor("c")).toBeUndefined();
    expect(cache.sessionFor("d")).toBe("sd");
  });
});

describe("NetworkingBearerLockout", () => {
  const { threshold, durationMs, windowMs } = NETWORKING_BEARER_LOCKOUT;

  it("locks a venue for ten minutes once 200 distinct bearers are rejected", () => {
    const lockout = new NetworkingBearerLockout();
    for (let i = 0; i < threshold - 1; i++) lockout.recordRejected("ip:event", `bad-${i}`);
    expect(lockout.lockedFor("ip:event")).toBe(0);
    lockout.recordRejected("ip:event", "bad-last");
    expect(lockout.lockedFor("ip:event")).toBe(durationMs);
    expect(lockout.lockedFor("ip:other")).toBe(0);
    vi.advanceTimersByTime(durationMs - 1);
    expect(lockout.lockedFor("ip:event")).toBe(1);
    vi.advanceTimersByTime(1);
    expect(lockout.lockedFor("ip:event")).toBe(0);
  });

  it("counts a retried stale token once", () => {
    const lockout = new NetworkingBearerLockout();
    for (let i = 0; i < 5; i++)
      for (let retry = 0; retry < 1_000; retry++) lockout.recordRejected("ip:event", `stale-${i}`);
    for (let i = 0; i < threshold - 6; i++) lockout.recordRejected("ip:event", `bad-${i}`);
    expect(lockout.lockedFor("ip:event")).toBe(0);
  });

  it("starts a fresh count after the ten-minute window", () => {
    const lockout = new NetworkingBearerLockout();
    for (let i = 0; i < threshold - 1; i++) lockout.recordRejected("ip:event", `old-${i}`);
    vi.advanceTimersByTime(windowMs);
    lockout.recordRejected("ip:event", "new");
    expect(lockout.lockedFor("ip:event")).toBe(0);
  });

  it("keeps a bounded number of venues", () => {
    const lockout = new NetworkingBearerLockout({ ...NETWORKING_BEARER_LOCKOUT, threshold: 1, maxVenues: 2 });
    lockout.recordRejected("a", "t");
    lockout.recordRejected("b", "t");
    lockout.recordRejected("c", "t");
    expect(lockout.lockedFor("a")).toBe(0);
    expect(lockout.lockedFor("b")).toBeGreaterThan(0);
    expect(lockout.lockedFor("c")).toBeGreaterThan(0);
  });
});

describe("networkingBearerToken", () => {
  it.each([
    ["Bearer abc", "abc"],
    ["bearer  abc", "abc"],
    ["Basic abc", undefined],
    ["Bearer a b", undefined],
    [undefined, undefined],
    [["Bearer abc"], undefined],
  ])("%j ⇒ %j", (header, expected) => {
    expect(networkingBearerToken(header)).toBe(expected);
  });
});
