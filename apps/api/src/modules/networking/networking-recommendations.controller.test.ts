import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ find: vi.fn(), hydrate: vi.fn() }));
vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/db")>()),
  findNetworkingVectorCandidates: mocks.find,
  getNetworkingRecommendationProfiles: mocks.hydrate,
}));
import { NetworkingRecommendationsController } from "./networking-recommendations.controller";
import type { NetworkingService } from "./networking.service";

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
    const controller = new NetworkingRecommendationsController({
      participant,
    } as unknown as NetworkingService);
    mocks.find
      .mockResolvedValueOnce([candidate("a")])
      .mockResolvedValueOnce([candidate("b")]);
    mocks.hydrate
      .mockResolvedValueOnce([{ id: "a", email: "secret@example.test" }])
      .mockResolvedValueOnce([{ id: "a" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "b" }]);
    const first = await controller.recommendations("event", "Bearer token");
    expect(first.items[0]).not.toHaveProperty("email");
    await controller.recommendations("event", "Bearer token");
    expect(mocks.find).toHaveBeenCalledTimes(1);
    expect(mocks.hydrate).toHaveBeenCalledTimes(2);
    const refreshed = await controller.recommendations("event", "Bearer token");
    expect(refreshed.items.map((p) => p.id)).toEqual(["b"]);
    expect(participant).toHaveBeenCalledTimes(3);
    expect(mocks.find).toHaveBeenCalledTimes(2);
    participant.mockRejectedValueOnce(new Error("session revoked"));
    await expect(
      controller.recommendations("event", "Bearer token"),
    ).rejects.toThrow("session revoked");
    expect(mocks.hydrate).toHaveBeenCalledTimes(4);
  });
});
