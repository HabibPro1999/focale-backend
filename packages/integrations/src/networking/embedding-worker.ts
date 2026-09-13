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

export async function processNetworkingEmbeddings(
  client: NetworkingEmbeddingClient | null = configuredNetworkingEmbeddingClient(),
) {
  if (!client) return { configured: false, processed: 0, failed: 0 };
  await enqueueChangedNetworkingEmbeddings(client.model);
  const jobs = (await claimNetworkingEmbeddingJobs(10)).map((job) => ({
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
      // One provider call embeds up to ten profiles (profile/offer/need each).
      vectors = await client.embed(
        changed.flatMap((job) =>
          job.input.documents.map((document) => document.text),
        ),
      );
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
