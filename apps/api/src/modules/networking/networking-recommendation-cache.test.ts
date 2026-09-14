import { afterEach, describe, expect, it, vi } from "vitest";
import { NetworkingRecommendationCache } from "./networking-recommendation-cache";

const matches = [
  {
    profileId: "candidate",
    score: 1,
    needsScore: 1,
    offersScore: 1,
    profileScore: 1,
  },
];
afterEach(() => vi.useRealTimers());

describe("networking candidate cache", () => {
  it("coalesces simultaneous loads and expires scores", async () => {
    vi.useFakeTimers();
    const cache = new NetworkingRecommendationCache(30_000);
    const load = vi.fn().mockResolvedValue(matches);
    await Promise.all([
      cache.get("event/profile/model/hash", load),
      cache.get("event/profile/model/hash", load),
    ]);
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_001);
    await cache.get("event/profile/model/hash", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("bounds memory and separates callers, events, and profile versions", async () => {
    const cache = new NetworkingRecommendationCache(30_000, 2);
    const load = vi.fn().mockResolvedValue(matches);
    await cache.get("event-a/profile-a/v1", load);
    await cache.get("event-b/profile-a/v1", load);
    await cache.get("event-a/profile-a/v2", load);
    await cache.get("event-a/profile-a/v1", load);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("does not cache missing embeddings, empty matches, or failures", async () => {
    const cache = new NetworkingRecommendationCache();
    const load = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue(matches);
    expect(await cache.get("key", load)).toBeNull();
    expect(await cache.get("key", load)).toEqual([]);
    await expect(cache.get("key", load)).rejects.toThrow(
      "database unavailable",
    );
    expect(await cache.get("key", load)).toEqual(matches);
    expect(load).toHaveBeenCalledTimes(4);
  });
});
