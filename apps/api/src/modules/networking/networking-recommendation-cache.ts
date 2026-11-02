import type { NetworkingVectorCandidate } from "@app/db";

type Candidates = NetworkingVectorCandidate[] | null;

/** Cache scores/IDs only. Every response must hydrate and recheck live eligibility. */
export class NetworkingRecommendationCache {
  private readonly entries = new Map<
    string,
    {
      expiresAt: number;
      result: Promise<Candidates>;
      value?: Candidates;
    }
  >();

  constructor(
    private readonly ttlMs = 30_000,
    private readonly capacity = 1_000,
  ) {}

  invalidate(key: string, expected: Candidates): void {
    if (this.entries.get(key)?.value === expected) this.entries.delete(key);
  }

  get(key: string, load: () => Promise<Candidates>): Promise<Candidates> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.result;
    }
    this.entries.delete(key);
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
    while (this.entries.size >= this.capacity) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    const entry: {
      expiresAt: number;
      result: Promise<Candidates>;
      value?: Candidates;
    } = {
      expiresAt: now + this.ttlMs,
      result: Promise.resolve<Candidates>(null),
    };
    entry.result = Promise.resolve()
      .then(load)
      .then(
        (result) => {
          entry.value = result;
          // Missing/pending embeddings should be retried on the next request.
          if (!result?.length && this.entries.get(key) === entry)
            this.entries.delete(key);
          return result;
        },
        (error) => {
          if (this.entries.get(key) === entry) this.entries.delete(key);
          throw error;
        },
      );
    this.entries.set(key, entry);
    return entry.result;
  }
}
