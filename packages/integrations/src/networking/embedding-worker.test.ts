import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({
  claimNetworkingEmbeddingJobs: vi.fn(),
  enqueueChangedNetworkingEmbeddings: vi.fn(),
  failNetworkingEmbeddingJob: vi.fn(),
  saveNetworkingEmbeddings: vi.fn(),
}));
vi.mock("@app/db", () => db);
import {
  processNetworkingEmbeddings,
  embeddingWorkerOptions,
} from "./embedding-worker";
import {
  profileEmbeddingInput,
  type NetworkingEmbeddingClient,
} from "./embeddings";
const profile = {
  id: "profile",
  eventId: "event",
  updatedAt: new Date(),
  company: "Company",
  jobTitle: "Role",
  sector: "Technology",
  bio: "",
  city: "",
  country: "",
  interests: [],
  offers: "Tools",
  seeks: "Partners",
};
beforeEach(() => vi.resetAllMocks());
describe("embedding worker lease outcomes", () => {
  it.each([true, false])(
    "does not count a lost lease or fail its new owner (unchanged=%s)",
    async (unchanged) => {
      db.claimNetworkingEmbeddingJobs.mockResolvedValue([
        {
          profile,
          lockToken: "old-lease",
          previous: {
            model: "test-model",
            source_hash: unchanged
              ? profileEmbeddingInput(profile).hash
              : "old-hash",
          },
        },
      ]);
      db.saveNetworkingEmbeddings.mockResolvedValue(false);
      const embed = vi.fn().mockResolvedValue([[1], [1], [1]]);
      expect(
        await processNetworkingEmbeddings(
          {
            model: "test-model",
            embed,
          } as unknown as NetworkingEmbeddingClient,
          { batchSize: 10, batchesPerTick: 1, concurrency: 1 },
        ),
      ).toEqual({ configured: true, processed: 0, failed: 0 });
      expect(db.failNetworkingEmbeddingJob).not.toHaveBeenCalled();
      expect(embed).toHaveBeenCalledTimes(unchanged ? 0 : 1);
    },
  );
});

describe("bounded embedding throughput", () => {
  const job = (id: string, long = false) => ({
    profile: {
      ...profile,
      id,
      bio: long ? "é".repeat(3000) : "",
      offers: long ? "界".repeat(2000) : id,
      seeks: long ? "界".repeat(2000) : "Partners",
    },
    lockToken: `lease-${id}`,
    previous: { model: null, source_hash: null },
  });
  it("does no work when unconfigured and stops claiming when the queue drains", async () => {
    expect(await processNetworkingEmbeddings(null)).toEqual({
      configured: false,
      processed: 0,
      failed: 0,
    });
    expect(db.enqueueChangedNetworkingEmbeddings).not.toHaveBeenCalled();
    db.claimNetworkingEmbeddingJobs.mockResolvedValue([]);
    const embed = vi.fn();
    await processNetworkingEmbeddings({
      model: "m",
      embed,
    } as unknown as NetworkingEmbeddingClient);
    expect(
      db.claimNetworkingEmbeddingJobs.mock.calls.length,
    ).toBeLessThanOrEqual(2);
    expect(embed).not.toHaveBeenCalled();
  });
  it("processes multiple batches without exceeding lane concurrency", async () => {
    let claimed = 0,
      inFlight = 0,
      peak = 0;
    db.claimNetworkingEmbeddingJobs.mockImplementation(async () => [
      job(String(claimed++)),
    ]);
    db.saveNetworkingEmbeddings.mockResolvedValue(true);
    const embed = vi.fn(async (documents: string[]) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight--;
      return documents.map(() => [1]);
    });
    expect(
      await processNetworkingEmbeddings(
        { model: "m", embed } as unknown as NetworkingEmbeddingClient,
        { batchSize: 16, batchesPerTick: 8, concurrency: 2 },
      ),
    ).toEqual({ configured: true, processed: 8, failed: 0 });
    expect(peak).toBe(2);
    expect(claimed).toBe(8);
    expect(db.enqueueChangedNetworkingEmbeddings).toHaveBeenCalledWith(
      "m",
      128,
    );
  });
  it("splits long multilingual batches and preserves vectors across request boundaries", async () => {
    const jobs = Array.from({ length: 32 }, (_, i) => job(String(i), true));
    db.claimNetworkingEmbeddingJobs.mockResolvedValue(jobs);
    db.saveNetworkingEmbeddings.mockResolvedValue(true);
    let next = 0;
    const embed = vi.fn(async (documents: string[]) => {
      expect(
        documents.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
      ).toBeLessThanOrEqual(200_000);
      expect(documents.length).toBeLessThanOrEqual(96);
      return documents.map(() => [next++]);
    });
    const result = await processNetworkingEmbeddings(
      { model: "m", embed } as unknown as NetworkingEmbeddingClient,
      { batchSize: 32, batchesPerTick: 1, concurrency: 1 },
    );
    expect(result.processed).toBe(32);
    expect(embed.mock.calls.length).toBeGreaterThan(1);
    for (let i = 0; i < 32; i++) {
      expect(
        db.saveNetworkingEmbeddings.mock.calls[i][0].embeddings.map(
          (entry: { embedding: number[] }) => entry.embedding,
        ),
      ).toEqual([[i * 3], [i * 3 + 1], [i * 3 + 2]]);
    }
  });
  it("requeues provider failures without saving partial vectors", async () => {
    db.claimNetworkingEmbeddingJobs.mockResolvedValue([job("a"), job("b")]);
    const embed = vi.fn().mockRejectedValue(new Error("rate limit"));
    expect(
      await processNetworkingEmbeddings(
        { model: "m", embed } as unknown as NetworkingEmbeddingClient,
        { batchSize: 2, batchesPerTick: 1, concurrency: 1 },
      ),
    ).toEqual({ configured: true, processed: 0, failed: 2 });
    expect(db.saveNetworkingEmbeddings).not.toHaveBeenCalled();
    expect(db.failNetworkingEmbeddingJob).toHaveBeenCalledWith("a", "lease-a");
  });
  it("rejects settings that can create unbounded work", () => {
    expect(() =>
      embeddingWorkerOptions({ NETWORKING_EMBEDDING_CONCURRENCY: "100" }),
    ).toThrow();
    expect(() =>
      embeddingWorkerOptions({ NETWORKING_EMBEDDING_BATCH_SIZE: "NaN" }),
    ).toThrow();
    expect(() =>
      embeddingWorkerOptions({ NETWORKING_EMBEDDING_BATCHES_PER_TICK: "0" }),
    ).toThrow();
  });
});
