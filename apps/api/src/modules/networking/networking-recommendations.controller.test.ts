import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ find: vi.fn(), hydrate: vi.fn() }));
vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/db")>()),
  findNetworkingVectorCandidates: mocks.find,
  getNetworkingRecommendationProfiles: mocks.hydrate,
}));
import { NetworkingRecommendationsController } from "./networking-recommendations.controller";
import type { NetworkingService } from "./networking.service";
import { NetworkingRecommendationsService } from "./networking-recommendations.service";

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
  it("authenticates and hydrates on every hit; refills after cached candidates become ineligible", async () => {
    const participant = vi
      .fn()
      .mockResolvedValue({
        event: { id: "event" },
        profile,
        config: { swipeEnabled: true, eligiblePaymentStatuses: ["PAID"] },
      });
    const service = { participant } as unknown as NetworkingService;
    const controller = new NetworkingRecommendationsController(service, new NetworkingRecommendationsService(service));
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
    await controller.recommendations("event", "127.0.0.1", "Bearer token");
    expect(mocks.find).toHaveBeenCalledTimes(1);
    expect(mocks.hydrate).toHaveBeenCalledTimes(2);
    const refreshed = await controller.recommendations("event", "127.0.0.1", "Bearer token");
    expect(refreshed.items.map((p) => p.id)).toEqual(["b"]);
    expect(participant).toHaveBeenCalledTimes(3);
    for (const call of participant.mock.calls)
      expect(call).toEqual(["event", "Bearer token", { ip: "127.0.0.1" }]);
    expect(mocks.find).toHaveBeenCalledTimes(2);
    participant.mockRejectedValueOnce(new Error("session revoked"));
    await expect(
      controller.recommendations("event", "127.0.0.1", "Bearer token"),
    ).rejects.toThrow("session revoked");
    expect(mocks.hydrate).toHaveBeenCalledTimes(4);
    expect(participant).toHaveBeenLastCalledWith("event", "Bearer token", { ip: "127.0.0.1" });
  });
});
