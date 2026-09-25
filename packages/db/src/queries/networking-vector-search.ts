import { sql } from "drizzle-orm";
import { getDb, type DbExecutor } from "../client";
import { rowsOf } from "../helpers";

export const NETWORKING_EXACT_PROFILE_LIMIT = 5000;
/** The CockroachDB ANN index from migration 0017 (deferred while embeddings exist). */
export const NETWORKING_VECTOR_INDEX = "networking_embeddings_cosine_idx";

type StatusExecutor = Pick<DbExecutor, "execute">;

/**
 * True when networking_embeddings has an ANN index the bounded candidate
 * search can use: 0017's CockroachDB vector index, or a pgvector HNSW/IVFFlat
 * index on PostgreSQL (which has no ANN migration). An index still being
 * built is not public yet, so it does not count.
 */
export async function networkingVectorIndexPresent(db: StatusExecutor = getDb()): Promise<boolean> {
  const [row] = rowsOf<{ present: boolean }>(
    await db.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM pg_catalog.pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'networking_embeddings'
        AND (indexname = ${NETWORKING_VECTOR_INDEX} OR indexdef ~* 'using (hnsw|ivfflat)')
    ) AS present
  `),
  );
  return row?.present === true || String(row?.present) === "true";
}

export interface NetworkingVectorIndexStatus {
  engine: "postgres" | "cockroach";
  present: boolean;
  /** Event/model pairs whose PROFILE embeddings exceed the exact-ranking limit. */
  eventsAboveThreshold: number;
  threshold: number;
  /** Recommendations for those events use deterministic profile rules instead of vectors. */
  fallbackActive: boolean;
}

/**
 * Read-only ANN index status for health and the runbook script. `model`
 * restricts the event count to the embedding model in use.
 */
export async function networkingVectorIndexStatus(
  options: { db?: StatusExecutor; model?: string } = {},
): Promise<NetworkingVectorIndexStatus> {
  const db = options.db ?? getDb();
  const [version] = rowsOf<{ version: string }>(await db.execute(sql`SELECT version() AS version`));
  const present = await networkingVectorIndexPresent(db);
  const [large] = rowsOf<{ count: number }>(
    await db.execute(sql`
    SELECT count(*)::int AS count FROM (
      SELECT event_id, model FROM networking_embeddings
      WHERE kind = 'PROFILE' ${options.model === undefined ? sql`` : sql`AND model = ${options.model}`}
      GROUP BY event_id, model HAVING count(*) > ${NETWORKING_EXACT_PROFILE_LIMIT}
    ) large
  `),
  );
  const eventsAboveThreshold = Number(large?.count ?? 0);
  return {
    engine: /CockroachDB/i.test(version?.version ?? "") ? "cockroach" : "postgres",
    present,
    eventsAboveThreshold,
    threshold: NETWORKING_EXACT_PROFILE_LIMIT,
    fallbackActive: !present && eventsAboveThreshold > 0,
  };
}

export interface NetworkingVectorIndexHealth {
  /** False while at least one large event ranks without vectors. */
  isHealthy: boolean;
  index: "present" | "missing";
  recommendations: "vector" | "deterministic-fallback";
  eventsAboveThreshold: number;
  threshold: number;
}
const HEALTH_TTL_MS = 60_000;
let healthCheck: { key: string; expiresAt: number; health: Promise<NetworkingVectorIndexHealth> } | undefined;
/**
 * Public health probe body: no engine or index names, cached for a minute so
 * an unauthenticated probe cannot drive repeated aggregate scans.
 */
export function getNetworkingVectorIndexHealth(model?: string): Promise<NetworkingVectorIndexHealth> {
  const now = Date.now(), key = model ?? "";
  if (healthCheck && healthCheck.key === key && healthCheck.expiresAt > now) return healthCheck.health;
  const health = networkingVectorIndexStatus({ model }).then((status) => ({
    isHealthy: !status.fallbackActive,
    index: status.present ? ("present" as const) : ("missing" as const),
    recommendations: status.fallbackActive ? ("deterministic-fallback" as const) : ("vector" as const),
    eventsAboveThreshold: status.eventsAboveThreshold,
    threshold: status.threshold,
  }));
  healthCheck = { key, expiresAt: now + HEALTH_TTL_MS, health };
  health.catch(() => {
    if (healthCheck?.health === health) healthCheck = undefined;
  });
  return health;
}
const INDEX_CHECK_TTL_MS = 60_000;
let indexCheck: { expiresAt: number; present: Promise<boolean> } | undefined;
/** Per-process view of the index for the recommendation hot path, refreshed every minute. */
function cachedVectorIndexPresent(): Promise<boolean> {
  const now = Date.now();
  if (!indexCheck || indexCheck.expiresAt <= now) {
    const present = networkingVectorIndexPresent();
    indexCheck = { expiresAt: now + INDEX_CHECK_TTL_MS, present };
    // A failed check is not cached.
    present.catch(() => {
      if (indexCheck?.present === present) indexCheck = undefined;
    });
  }
  return indexCheck.present;
}
/** Forget the cached index checks (tests, or right after the runbook built the index). */
export function clearNetworkingVectorIndexCache(): void {
  indexCheck = undefined;
  healthCheck = undefined;
}

export interface NetworkingVectorCandidate {
  profileId: string;
  score: number;
  needsScore: number;
  offersScore: number;
  profileScore: number;
}

/**
 * Exact weighted ranking for small events; bounded ANN candidate retrieval for
 * large ones. Null means "no vector ranking": the caller falls back to the
 * deterministic profile rules. That includes an event above the exact limit
 * while the ANN index is missing, where every search would scan and sort the
 * event's embeddings (`requireVectorIndex: false` is for the benchmark only).
 */
export async function findNetworkingVectorCandidates(
  eventId: string,
  profileId: string,
  model: string,
  paymentStatuses: readonly string[],
  limit = 60,
  options: { requireVectorIndex?: boolean } = {},
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
  if (options.requireVectorIndex !== false && !(await cachedVectorIndexPresent())) return null;

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
          ? sql`AND p.id = ANY(${sql.param(candidateIds)}::text[])`
          : sql``
      } AND p.id<>${profileId} AND lower(p.email)<>lower(source.email) AND p.status='ACTIVE' AND p.visible AND p.consent AND p.withdrawn_at IS NULL
        AND btrim(p.first_name)<>'' AND btrim(p.last_name)<>'' AND btrim(p.company)<>'' AND btrim(p.job_title)<>'' AND btrim(p.sector)<>''
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
