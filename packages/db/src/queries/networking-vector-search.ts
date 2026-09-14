import { sql } from "drizzle-orm";
import { getDb } from "../client";
import { rowsOf } from "../helpers";

export const NETWORKING_EXACT_PROFILE_LIMIT = 5000;

export interface NetworkingVectorCandidate {
  profileId: string;
  score: number;
  needsScore: number;
  offersScore: number;
  profileScore: number;
}

/** Exact weighted ranking for small events; bounded ANN candidate retrieval for large ones. */
export async function findNetworkingVectorCandidates(
  eventId: string,
  profileId: string,
  model: string,
  paymentStatuses: readonly string[],
  limit = 60,
): Promise<NetworkingVectorCandidate[] | null> {
  if (!paymentStatuses.length) return [];
  const db = getDb();
  const requested = Math.min(100, Math.max(1, Math.floor(limit) || 60));
  const source = rowsOf<Source>(
    await db.execute(sql`
    SELECT pe.embedding::text AS profile, oe.embedding::text AS offer, ne.embedding::text AS need,
      p.offers, p.seeks
    FROM networking_profiles p
    JOIN networking_embedding_jobs j ON j.profile_id=p.id AND j.status='READY' AND j.model=${model}
    JOIN networking_embeddings pe ON pe.profile_id=p.id AND pe.kind='PROFILE' AND pe.model=${model} AND pe.source_hash=j.source_hash
    JOIN networking_embeddings oe ON oe.profile_id=p.id AND oe.kind='OFFER' AND oe.model=${model} AND oe.source_hash=pe.source_hash
    JOIN networking_embeddings ne ON ne.profile_id=p.id AND ne.kind='NEED' AND ne.model=${model} AND ne.source_hash=pe.source_hash
    WHERE p.id=${profileId} AND p.event_id=${eventId}
  `),
  )[0];
  if (!source) return null;
  // A capped index-only count avoids COUNT(*) across a large event on every miss.
  const size = rowsOf<{ count: number }>(
    await db.execute(sql`
    SELECT count(*)::int AS count FROM (
      SELECT 1 FROM networking_embeddings
      WHERE event_id=${eventId} AND kind='PROFILE' AND model=${model} LIMIT ${NETWORKING_EXACT_PROFILE_LIMIT + 1}
    ) population
  `),
  )[0].count;
  if (Number(size) <= NETWORKING_EXACT_PROFILE_LIMIT)
    return rankNetworkingVectorCandidates(
      eventId,
      profileId,
      model,
      paymentStatuses,
      requested,
    );

  // Search each complementary signal separately, then rerank the union exactly.
  // Keep ORDER BY as a bare distance against a constant so the vector index is usable.
  // Widen a bounded number of times when eligibility filters remove most neighbors.
  for (const breadth of [Math.max(240, requested * 4), 960, 3840]) {
    const searches: Array<[string, string]> = [["PROFILE", source.profile]];
    if (source.seeks.trim()) searches.push(["OFFER", source.need]);
    if (source.offers.trim()) searches.push(["NEED", source.offer]);
    const neighbors = await Promise.all(
      searches.map(async ([kind, vector]) =>
        rowsOf<{ profile_id: string }>(
          await db.execute(sql`
        SELECT profile_id FROM networking_embeddings
        WHERE event_id=${eventId} AND kind=${kind} AND model=${model}
        ORDER BY embedding <=> ${vector}::vector LIMIT ${breadth}
      `),
        ),
      ),
    );
    const ids = [...new Set(neighbors.flat().map((row) => row.profile_id))];
    if (!ids.length) return [];
    const ranked = await rankNetworkingVectorCandidates(
      eventId,
      profileId,
      model,
      paymentStatuses,
      requested,
      ids,
    );
    if (ranked.length >= requested || breadth === 3840) return ranked;
  }
  return [];
}

interface Source {
  profile: string;
  offer: string;
  need: string;
  offers: string;
  seeks: string;
}

/** Exact baseline, also used by the isolated recall/latency benchmark. */
export async function rankNetworkingVectorCandidates(
  eventId: string,
  profileId: string,
  model: string,
  paymentStatuses: readonly string[],
  limit: number,
  candidateIds?: string[],
): Promise<NetworkingVectorCandidate[]> {
  const db = getDb();
  const rows = rowsOf<{
    profile_id: string;
    score: number;
    needs_score: number;
    offers_score: number;
    profile_score: number;
  }>(
    await db.execute(sql`
    WITH source AS (
      SELECT p.id,p.email,p.offers,p.seeks,pe.embedding AS profile,oe.embedding AS offer,ne.embedding AS need
      FROM networking_profiles p
      JOIN networking_embeddings pe ON pe.profile_id=p.id AND pe.kind='PROFILE' AND pe.model=${model}
      JOIN networking_embeddings oe ON oe.profile_id=p.id AND oe.kind='OFFER' AND oe.model=pe.model AND oe.source_hash=pe.source_hash
      JOIN networking_embeddings ne ON ne.profile_id=p.id AND ne.kind='NEED' AND ne.model=pe.model AND ne.source_hash=pe.source_hash
      WHERE p.id=${profileId} AND p.event_id=${eventId}
    ), scores AS (
      SELECT p.id AS profile_id,
        CASE WHEN length(trim(source.seeks))>0 AND length(trim(p.offers))>0 THEN greatest(0,1-(source.need <=> oe.embedding)) ELSE 0 END AS needs_score,
        CASE WHEN length(trim(source.offers))>0 AND length(trim(p.seeks))>0 THEN greatest(0,1-(source.offer <=> ne.embedding)) ELSE 0 END AS offers_score,
        greatest(0,1-(source.profile <=> pe.embedding)) AS profile_score
      FROM networking_profiles p
      JOIN registrations r ON r.id=p.registration_id AND r.event_id=p.event_id
      JOIN networking_embeddings pe ON pe.profile_id=p.id AND pe.kind='PROFILE' AND pe.event_id=${eventId} AND pe.model=${model}
      JOIN networking_embeddings oe ON oe.profile_id=p.id AND oe.kind='OFFER' AND oe.model=pe.model AND oe.source_hash=pe.source_hash
      JOIN networking_embeddings ne ON ne.profile_id=p.id AND ne.kind='NEED' AND ne.model=pe.model AND ne.source_hash=pe.source_hash
      CROSS JOIN source
      WHERE p.event_id=${eventId} ${
        candidateIds
          ? sql`AND p.id IN (${sql.join(
              candidateIds.map((id) => sql`${id}`),
              sql`,`,
            )})`
          : sql``
      } AND p.id<>${profileId} AND lower(p.email)<>lower(source.email) AND p.status='ACTIVE' AND p.visible AND p.consent AND p.withdrawn_at IS NULL
        AND r.networking_opt_in IS DISTINCT FROM false AND r.payment_status::text IN (${sql.join(
          paymentStatuses.map((status) => sql`${status}`),
          sql`,`,
        )})
        AND NOT EXISTS (SELECT 1 FROM networking_blocks b WHERE b.event_id=p.event_id AND ((b.profile_id=${profileId} AND b.target_id=p.id) OR (b.profile_id=p.id AND b.target_id=${profileId})))
        AND NOT EXISTS (SELECT 1 FROM networking_interests i WHERE i.event_id=p.event_id AND i.profile_id=${profileId} AND i.target_id=p.id)
        AND NOT EXISTS (SELECT 1 FROM networking_connections c WHERE c.event_id=p.event_id AND ((c.profile_a_id=${profileId} AND c.profile_b_id=p.id) OR (c.profile_b_id=${profileId} AND c.profile_a_id=p.id)))
    )
    SELECT *, (0.4*needs_score + 0.4*offers_score + 0.2*profile_score) AS score FROM scores
    ORDER BY score DESC,profile_id LIMIT ${Math.min(100, Math.max(1, limit))}
  `),
  );
  return rows.map((row) => ({
    profileId: row.profile_id,
    score: Number(row.score),
    needsScore: Number(row.needs_score),
    offersScore: Number(row.offers_score),
    profileScore: Number(row.profile_score),
  }));
}
