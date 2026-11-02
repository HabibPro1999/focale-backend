import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkingEmailRateLimiter } from "./email-rate-limiter";

describe("NetworkingEmailRateLimiter", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date("2030-01-01T00:00:00Z") }));
  afterEach(() => vi.useRealTimers());

  const track = (limiter: NetworkingEmailRateLimiter, label: string, priority: "otp" | "other", order: string[]) =>
    limiter.take(priority).then(() => void order.push(label));

  it("allows one second's worth at once, then refills at the rate", async () => {
    const limiter = new NetworkingEmailRateLimiter(2);
    const order: string[] = [];
    for (const label of ["a", "b", "c", "d"]) void track(limiter, label, "other", order);
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(order).toEqual(["a", "b", "c"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(order).toEqual(["a", "b", "c", "d"]);
  });

  it("serves a waiting sign-in code before earlier queued emails", async () => {
    const limiter = new NetworkingEmailRateLimiter(1);
    const order: string[] = [];
    for (const label of ["d1", "d2", "d3"]) void track(limiter, label, "other", order);
    void track(limiter, "otp", "otp", order);
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["d1"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(order).toEqual(["d1", "otp"]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(order).toEqual(["d1", "otp", "d2", "d3"]);
  });

  it("pauses every sender after a 429, doubling the pause until an email is accepted", async () => {
    const limiter = new NetworkingEmailRateLimiter(100);
    const start = Date.now();
    expect(limiter.rateLimited()).toBe(start + 1_000);
    expect(limiter.rateLimited()).toBe(start + 2_000);
    const order: string[] = [];
    void track(limiter, "after", "otp", order);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(20);
    expect(order).toEqual(["after"]);
    limiter.succeeded();
    expect(limiter.rateLimited()).toBe(Date.now() + 1_000);
  });

  it("caps the pause at one minute", () => {
    const limiter = new NetworkingEmailRateLimiter(1);
    let until = 0;
    for (let index = 0; index < 10; index++) until = limiter.rateLimited();
    expect(until - Date.now()).toBe(60_000);
  });

  it("drops a waiter whose signal aborts", async () => {
    const limiter = new NetworkingEmailRateLimiter(1);
    await limiter.take("other");
    const controller = new AbortController();
    const waiting = limiter.take("other", controller.signal);
    expect(limiter.pending).toBe(1);
    controller.abort(new Error("shutdown"));
    await expect(waiting).rejects.toThrow("shutdown");
    expect(limiter.pending).toBe(0);
  });
});
