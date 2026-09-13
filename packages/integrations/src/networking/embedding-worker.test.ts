import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ claimNetworkingEmbeddingJobs: vi.fn(), enqueueChangedNetworkingEmbeddings: vi.fn(), failNetworkingEmbeddingJob: vi.fn(), saveNetworkingEmbeddings: vi.fn() }));
vi.mock("@app/db", () => db);
import { processNetworkingEmbeddings } from "./embedding-worker";
import { profileEmbeddingInput, type NetworkingEmbeddingClient } from "./embeddings";
const profile = { id: "profile", eventId: "event", updatedAt: new Date(), company: "Company", jobTitle: "Role", sector: "Technology", bio: "", city: "", country: "", interests: [], offers: "Tools", seeks: "Partners" };
beforeEach(() => vi.clearAllMocks());
describe("embedding worker lease outcomes", () => {
  it.each([true, false])("does not count a lost lease or fail its new owner (unchanged=%s)", async unchanged => {
    db.claimNetworkingEmbeddingJobs.mockResolvedValue([{ profile, lockToken: "old-lease", previous: { model: "test-model", source_hash: unchanged ? profileEmbeddingInput(profile).hash : "old-hash" } }]);
    db.saveNetworkingEmbeddings.mockResolvedValue(false);
    const embed = vi.fn().mockResolvedValue([[1], [1], [1]]);
    expect(await processNetworkingEmbeddings({ model: "test-model", embed } as unknown as NetworkingEmbeddingClient)).toEqual({ configured: true, processed: 0, failed: 0 });
    expect(db.failNetworkingEmbeddingJob).not.toHaveBeenCalled();
    expect(embed).toHaveBeenCalledTimes(unchanged ? 0 : 1);
  });
});
