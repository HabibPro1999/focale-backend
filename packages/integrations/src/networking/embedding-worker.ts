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
import { integrationsConfigFromEnv } from "@app/contracts";
import { networkingConfig } from "../config";
import { runClaimLanes } from "./lanes";

export interface EmbeddingWorkerOptions {
  batchSize: number;
  batchesPerTick: number;
  concurrency: number;
}

/**
 * Worker throughput bounds (validated by the config schema): the configured
 * slice, or `source` parsed with the same rules when given.
 */
export function embeddingWorkerOptions(source?: NodeJS.ProcessEnv): EmbeddingWorkerOptions {
  const { batchSize, batchesPerTick, concurrency } = (
    source ? integrationsConfigFromEnv(source).networking : networkingConfig()
  ).embedding;
  return { batchSize, batchesPerTick, concurrency };
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
  const totals = { configured: true, processed: 0, failed: 0 };
  // Claim only when a lane is ready, so leases do not expire waiting for a slot.
  await runClaimLanes([
    {
      lanes: options.concurrency,
      maxBatches: options.batchesPerTick,
      claim: () => claimNetworkingEmbeddingJobs(options.batchSize),
      process: async (claimed: Awaited<ReturnType<typeof claimNetworkingEmbeddingJobs>>) => {
        const result = await processBatch(client, claimed);
        totals.processed += result.processed;
        totals.failed += result.failed;
      },
    },
  ]);
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
