import {
  claimNetworkingEmbeddingJobs,
  enqueueChangedNetworkingEmbeddings,
  failNetworkingEmbeddingJob,
  saveNetworkingEmbeddings,
} from "@app/db";
import {
  configuredNetworkingEmbeddingClient,
  profileEmbeddingInput,
  type NetworkingEmbeddingClient,
} from "./embeddings";

export interface EmbeddingWorkerOptions {
  batchSize: number;
  batchesPerTick: number;
  concurrency: number;
}

export function embeddingWorkerOptions(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingWorkerOptions {
  const read = (key: string, fallback: number, maximum: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${key} must be an integer between 1 and ${maximum}`);
    }
    return value;
  };
  return {
    batchSize: read("NETWORKING_EMBEDDING_BATCH_SIZE", 16, 32),
    batchesPerTick: read("NETWORKING_EMBEDDING_BATCHES_PER_TICK", 8, 32),
    concurrency: read("NETWORKING_EMBEDDING_CONCURRENCY", 2, 4),
  };
}

export async function processNetworkingEmbeddings(
  client: NetworkingEmbeddingClient | null = configuredNetworkingEmbeddingClient(),
  options = embeddingWorkerOptions(),
) {
  if (!client) return { configured: false, processed: 0, failed: 0 };
  await enqueueChangedNetworkingEmbeddings(
    client.model,
    options.batchSize * options.batchesPerTick,
  );
  let nextBatch = 0;
  let drained = false;
  const totals = { configured: true, processed: 0, failed: 0 };
  const lanes = await Promise.allSettled(
    Array.from({ length: options.concurrency }, async () => {
      while (!drained && nextBatch++ < options.batchesPerTick) {
        // Claim only when a lane is ready, so leases do not expire waiting for a slot.
        const claimed = await claimNetworkingEmbeddingJobs(options.batchSize);
        if (!claimed.length) {
          drained = true;
          break;
        }
        const result = await processBatch(client, claimed);
        totals.processed += result.processed;
        totals.failed += result.failed;
      }
    }),
  );
  const error = lanes.find((result) => result.status === "rejected");
  if (error?.status === "rejected") throw error.reason;
  return totals;
}

async function processBatch(
  client: NetworkingEmbeddingClient,
  claimed: Awaited<ReturnType<typeof claimNetworkingEmbeddingJobs>>,
) {
  const jobs = claimed.map((job) => ({
    ...job,
    input: profileEmbeddingInput(job.profile),
  }));
  const changed = jobs.filter(
    (job) =>
      job.previous.source_hash !== job.input.hash ||
      job.previous.model !== client.model,
  );
  const unchanged = jobs.filter((job) => !changed.includes(job));
  let processed = 0;
  let failed = 0;
  for (const job of unchanged) {
    const saved = await saveNetworkingEmbeddings({
      profileId: job.profile.id,
      eventId: job.profile.eventId,
      lockToken: job.lockToken,
      model: client.model,
      sourceHash: job.input.hash,
      indexedProfileAt: job.profile.updatedAt,
    });
    if (saved) processed++;
  }
  if (changed.length) {
    let vectors: number[][];
    try {
      vectors = [];
      const documents = changed.flatMap((job) =>
        job.input.documents.map((document) => document.text),
      );
      // UTF-8 bytes upper-bound token count. Stay below the provider's 300k-token
      // request limit even for long multilingual text; retain input/output order.
      let batch: string[] = [];
      let bytes = 0;
      for (const document of documents) {
        const size = Buffer.byteLength(document, "utf8");
        if (batch.length && (bytes + size > 200_000 || batch.length === 96)) {
          vectors.push(...(await client.embed(batch)));
          batch = [];
          bytes = 0;
        }
        batch.push(document);
        bytes += size;
      }
      if (batch.length) vectors.push(...(await client.embed(batch)));
    } catch {
      for (const job of changed)
        await failNetworkingEmbeddingJob(job.profile.id, job.lockToken);
      return { configured: true, processed, failed: changed.length };
    }
    for (const [index, job] of changed.entries()) {
      try {
        const saved = await saveNetworkingEmbeddings({
          profileId: job.profile.id,
          eventId: job.profile.eventId,
          lockToken: job.lockToken,
          model: client.model,
          sourceHash: job.input.hash,
          indexedProfileAt: job.profile.updatedAt,
          embeddings: job.input.documents.map((document, offset) => ({
            kind: document.kind,
            embedding: vectors[index * 3 + offset]!,
          })),
        });
        if (saved) processed++;
      } catch {
        await failNetworkingEmbeddingJob(job.profile.id, job.lockToken);
        failed++;
      }
    }
  }
  return { configured: true, processed, failed };
}
