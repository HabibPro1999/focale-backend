/** Isolated synthetic benchmark: never connects to .env or an external DB. */
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { sql } from "drizzle-orm";
import { getDb } from "../src/client";
import { rowsOf } from "../src/helpers";
import {
  networkingEmbeddings,
  networkingEmbeddingJobs,
} from "../src/schema/networking-embeddings";
import {
  findNetworkingVectorCandidates,
  NETWORKING_EXACT_PROFILE_LIMIT,
  rankNetworkingVectorCandidates,
} from "../src/queries/networking-vector-search";
import { getNetworkingRecommendationProfiles } from "../src/queries/networking-embeddings";
import { createNetworkingScaleFixture } from "../tests/helpers/networking-fixture";

async function main() {
  if (process.env.ALLOW_DB_TESTS !== "1" || !process.env.TEST_DATABASE_URL)
    throw new Error(
      "Opt in with ALLOW_DB_TESTS=1 and a local TEST_DATABASE_URL",
    );
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    !/^\/focale_networking_test_/.test(url.pathname)
  ) {
    throw new Error(
      "Requires a dedicated local focale_networking_test_ database",
    );
  }
  const size = Number(process.env.NETWORKING_VECTOR_SIZE ?? 10000);
  if (
    !Number.isInteger(size) ||
    size <= NETWORKING_EXACT_PROFILE_LIMIT ||
    size > 100_000
  )
    throw new Error(
      `Size must be ${NETWORKING_EXACT_PROFILE_LIMIT + 1}–100000 to exercise ANN`,
    );
  process.env.DATABASE_URL = url.toString();
  const db = getDb();
  const model = "synthetic-vector-benchmark";
  console.log(`Creating ${size} isolated profiles; no OpenAI calls.`);
  const fixture = await createNetworkingScaleFixture(size, (value) =>
    createHash("sha256").update(value).digest("hex"),
  );
  try {
    // 1536 stored dimensions, with 32 synthetic latent features and zero padding.
    // This makes the fixture reproducible; it is not a real-world relevance evaluation.
    const vector = (index: number, kind: number) => {
      const result = Array.from({ length: 1536 }, (_, d) =>
        d < 32 ? Math.sin((index + 1) * (d + 1) * (kind + 1) * 1.618) : 0,
      );
      const norm = Math.hypot(...result);
      return result.map((value) => value / norm);
    };
    for (let offset = 0; offset < size; offset += 100) {
      const batch = fixture.pairs.slice(offset, offset + 100);
      await db.insert(networkingEmbeddings).values(
        batch.flatMap((p) =>
          (["PROFILE", "OFFER", "NEED"] as const).map((kind, k) => ({
            profileId: p.profileId,
            eventId: fixture.event!.id,
            model,
            kind,
            sourceHash: "synthetic",
            embedding: vector(p.index, k),
          })),
        ),
      );
      await db.insert(networkingEmbeddingJobs).values(
        batch.map((p) => ({
          profileId: p.profileId,
          model,
          status: "READY" as const,
          sourceHash: "synthetic",
          indexedProfileAt: new Date(),
        })),
      );
      if (offset % 5000 === 0)
        console.log(`Embedded ${Math.min(offset + 100, size)}/${size}`);
    }
    const engine = rowsOf<{ version: string }>(
      await db.execute(sql`SELECT version() AS version`),
    )[0].version;
    const cockroach = engine.includes("CockroachDB");
    await db.execute(
      cockroach
        ? sql`CREATE STATISTICS networking_vector_benchmark FROM networking_embeddings`
        : sql`ANALYZE networking_embeddings`,
    );
    const probe = `[${vector(0, 0).join(",")}]`;
    const plan = rowsOf(
      await db.execute(sql`EXPLAIN SELECT profile_id FROM networking_embeddings
      WHERE event_id=${fixture.event!.id} AND kind='PROFILE' AND model=${model}
      ORDER BY embedding <=> ${probe}::vector LIMIT 240`),
    );
    if (
      cockroach &&
      !JSON.stringify(plan).includes("networking_embeddings_cosine_idx")
    ) {
      throw new Error(
        "ANN probe did not select the event-prefixed cosine index",
      );
    }
    const samples = [];
    for (const actor of [
      fixture.pairs[0],
      fixture.pairs[103],
      fixture.pairs[107],
    ]) {
      const args = [
        fixture.event!.id,
        actor.profileId,
        model,
        ["PAID"],
      ] as const;
      const start = performance.now();
      const exact = await rankNetworkingVectorCandidates(...args, 30);
      const exactMs = performance.now() - start;
      const annStart = performance.now();
      // Measures the ANN path itself, with or without an index (production falls back without one).
      const matches = (await findNetworkingVectorCandidates(
        ...args,
        60,
        { requireVectorIndex: false },
      ))!.slice(0, 30);
      const annMs = performance.now() - annStart;
      const eligible = await getNetworkingRecommendationProfiles(
        args[0],
        matches.map((p) => p.profileId),
        actor.profileId,
        ["PAID"],
      );
      if (eligible.length !== matches.length)
        throw new Error("Ineligible candidate escaped retrieval filters");
      const exactIds = new Set(exact.map((row) => row.profileId));
      samples.push({
        exactMs: Math.round(exactMs),
        annMs: Math.round(annMs),
        recallAt30:
          matches.filter((row) => exactIds.has(row.profileId)).length /
          exact.length,
        returned: matches.length,
      });
      console.log(JSON.stringify(samples.at(-1)));
    }
    const report = {
      profiles: size,
      exactProfileLimit: NETWORKING_EXACT_PROFILE_LIMIT,
      engine,
      dimensions: 1536,
      syntheticLatentDimensions: 32,
      samples,
      plan,
      limitations:
        "Three sequential callers on a local single-node database, synthetic vectors, no real-profile relevance or production concurrency claim.",
    };
    if (process.env.NETWORKING_VECTOR_REPORT)
      await writeFile(
        process.env.NETWORKING_VECTOR_REPORT,
        JSON.stringify(report, null, 2) + "\n",
      );
    if (samples.some((sample) => sample.recallAt30 < 0.8))
      throw new Error(
        "Synthetic recall@30 fell below 0.8; increase shortlist breadth or investigate before rollout",
      );
  } finally {
    // Delete vectors in small batches before cascading parent removal. A large
    // CockroachDB cascade can otherwise spend minutes in one transaction.
    while (true) {
      const removed = rowsOf(
        await db.execute(sql`
        DELETE FROM networking_embeddings WHERE id IN (
          SELECT id FROM networking_embeddings WHERE event_id=${fixture.event!.id} LIMIT 500
        ) RETURNING id
      `),
      );
      if (!removed.length) break;
    }
    await fixture.cleanup();
    await (
      db as unknown as { $client: { end(): Promise<void> } }
    ).$client.end();
  }
}
main().catch((error) => {
  console.error(error.cause?.message ?? error.message);
  process.exitCode = 1;
});
