import { NetworkingRecommendationsService } from "./networking.recommendations.service";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkingRecommendationsController } from "./networking-recommendations.controller";
import type { NetworkingService } from "./networking.service";
const mocks = vi.hoisted(() => ({ find: vi.fn(), hydrate: vi.fn() }));
vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/db")>()),
  findNetworkingVectorCandidates: mocks.find,
  getNetworkingRecommendationProfiles: mocks.hydrate,
}));

const profile = {
  id: "caller",
  company: "Company",
  jobTitle: "Role",
  sector: "Health",
  bio: "",
  interests: [],
  city: "",
  country: "",
  offers: "Sites",
  seeks: "Funding",
  language: "en",
};
const candidate = (id: string) => ({
  profileId: id,
  score: 1,
  needsScore: 1,
  offersScore: 1,
  profileScore: 1,
});
beforeEach(() => vi.resetAllMocks());
describe("recommendation caching boundary", () => {
  it("preserves the rule fallback ranking, discovery filters and reasons", async () => {
    const discover = vi.fn().mockResolvedValue({ items: [
      { id: "other", interests: ["Other"], sector: "Other" },
      { id: "shared", interests: ["HEALTH"], sector: "Health" },
      { id: "sector", interests: [], sector: "Health" },
    ] });
    const participant = vi.fn().mockResolvedValue({ event: { id: "event" }, profile: { ...profile, interests: ["Health"] }, config: { swipeEnabled: true, eligiblePaymentStatuses: ["PAID"] } });
    const networking = { participant, discover } as unknown as NetworkingService;
    const controller = new NetworkingRecommendationsController(networking, new NetworkingRecommendationsService(networking));
    mocks.find.mockResolvedValue(null);
    const result = await controller.recommendations("event", "127.0.0.1", "Bearer token");
    expect(result).toEqual({ strategy: "PROFILE_RULES", total: 3, items: [
      { id: "shared", interests: ["HEALTH"], sector: "Health", score: 2, reasons: ["HEALTH"] },
      { id: "sector", interests: [], sector: "Health", score: 1, reasons: [] },
      { id: "other", interests: ["Other"], sector: "Other", score: 0, reasons: [] },
    ] });
    expect(discover).toHaveBeenCalledWith(expect.anything(), { sort: "recent", limit: 100, excludeInteracted: true });
    expect(mocks.hydrate).not.toHaveBeenCalled();
  });
  it("authenticates and hydrates on every hit; refills after cached candidates become ineligible", async () => {
    const participant = vi
      .fn()
      .mockResolvedValue({
        event: { id: "event" },
        profile,
        config: { swipeEnabled: true, eligiblePaymentStatuses: ["PAID"] },
      });
    const networking = { participant } as unknown as NetworkingService;
    const controller = new NetworkingRecommendationsController(networking, new NetworkingRecommendationsService(networking));
    mocks.find
      .mockResolvedValueOnce([candidate("a")])
      .mockResolvedValueOnce([candidate("b")]);
    mocks.hydrate
      .mockResolvedValueOnce([{ id: "a", email: "secret@example.test" }])
      .mockResolvedValueOnce([{ id: "a" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "b" }]);
    const first = await controller.recommendations("event", "127.0.0.1", "Bearer token");
    expect(first.items[0]).not.toHaveProperty("email");
    expect(participant).toHaveBeenCalledWith("event", "Bearer token", { ip: "127.0.0.1" });
    await controller.recommendations("event", "127.0.0.1", "Bearer token");
    expect(mocks.find).toHaveBeenCalledTimes(1);
    expect(mocks.hydrate).toHaveBeenCalledTimes(2);
    const refreshed = await controller.recommendations("event", "127.0.0.1", "Bearer token");
    expect(refreshed.items.map((p) => p.id)).toEqual(["b"]);
    expect(participant).toHaveBeenCalledTimes(3);
    expect(mocks.find).toHaveBeenCalledTimes(2);
    participant.mockRejectedValueOnce(new Error("session revoked"));
    await expect(
      controller.recommendations("event", "127.0.0.1", "Bearer token"),
    ).rejects.toThrow("session revoked");
    expect(mocks.hydrate).toHaveBeenCalledTimes(4);
  });
});
